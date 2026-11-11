package api

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/BrendenWalker/foodlog/server/internal/store"
)

type Server struct {
	Store    store.Store
	MaxBytes int64
	Origins  []string
}

// Routes returns the API mux without middleware. Wire CORS outside auth so
// browser preflight (OPTIONS, no Authorization) and 401 bodies still get
// Access-Control-* headers.
func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.healthz)
	mux.HandleFunc("GET /v1/meta", s.meta)
	mux.HandleFunc("GET /v1/dump", s.dump)
	mux.HandleFunc("PUT /v1/dump", s.putDump)
	mux.HandleFunc("GET /v1/{table}", s.list)
	mux.HandleFunc("PUT /v1/{table}/{id}", s.put)
	mux.HandleFunc("DELETE /v1/{table}/{id}", s.del)
	mux.HandleFunc("PUT /v1/{table}", s.replaceTable)
	return mux
}

// CORS wraps next with Origin allowlist handling and OPTIONS short-circuit.
func (s *Server) CORS(next http.Handler) http.Handler {
	return s.cors(next)
}

// Handler is Routes with CORS only (no auth). Prefer CORS(auth(Routes())) in main.
func (s *Server) Handler() http.Handler {
	return s.CORS(s.Routes())
}

func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	if err := s.Store.Ping(r.Context()); err != nil {
		http.Error(w, "db unavailable", http.StatusServiceUnavailable)
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

func (s *Server) meta(w http.ResponseWriter, r *http.Request) {
	meta, err := s.Store.Meta(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, meta)
}

func (s *Server) list(w http.ResponseWriter, r *http.Request) {
	table := r.PathValue("table")
	if !store.ValidTable(table) {
		http.NotFound(w, r)
		return
	}
	docs, err := s.Store.List(r.Context(), table)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, docs)
}

func (s *Server) put(w http.ResponseWriter, r *http.Request) {
	table := r.PathValue("table")
	id := r.PathValue("id")
	if !store.ValidTable(table) || id == "" {
		http.NotFound(w, r)
		return
	}
	if err := s.maybeIdempotent(r); err != nil {
		if err == errDuplicate {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	body, err := readBody(r, s.MaxBytes)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	docID, err := store.DocID(table, body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if docID != id {
		http.Error(w, "id mismatch", http.StatusBadRequest)
		return
	}
	if err := s.Store.Put(r.Context(), table, id, body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	_ = s.remember(r)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) del(w http.ResponseWriter, r *http.Request) {
	table := r.PathValue("table")
	id := r.PathValue("id")
	if !store.ValidTable(table) || id == "" {
		http.NotFound(w, r)
		return
	}
	if err := s.maybeIdempotent(r); err != nil {
		if err == errDuplicate {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := s.Store.Delete(r.Context(), table, id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = s.remember(r)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) replaceTable(w http.ResponseWriter, r *http.Request) {
	table := r.PathValue("table")
	if !store.ValidTable(table) {
		http.NotFound(w, r)
		return
	}
	body, err := readBody(r, s.MaxBytes)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	var docs []json.RawMessage
	if err := json.Unmarshal(body, &docs); err != nil {
		http.Error(w, "expected a JSON array", http.StatusBadRequest)
		return
	}
	if err := s.Store.ReplaceAll(r.Context(), table, docs); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) dump(w http.ResponseWriter, r *http.Request) {
	out := map[string]any{}
	meta, err := s.Store.Meta(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	out["meta"] = meta
	for _, table := range store.Tables {
		docs, err := s.Store.List(r.Context(), table)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out[table] = docs
	}
	writeJSON(w, out)
}

func (s *Server) putDump(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(r, s.MaxBytes)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(body, &payload); err != nil {
		http.Error(w, "expected a JSON object", http.StatusBadRequest)
		return
	}
	for _, table := range store.Tables {
		raw, ok := payload[table]
		if !ok {
			continue
		}
		docs, err := asDocList(table, raw)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := s.Store.ReplaceAll(r.Context(), table, docs); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

var errDuplicate = errString("duplicate mutation")

type errString string

func (e errString) Error() string { return string(e) }

func (s *Server) maybeIdempotent(r *http.Request) error {
	id := strings.TrimSpace(r.Header.Get("X-Client-Mutation-Id"))
	if id == "" {
		return nil
	}
	seen, err := s.Store.SeenMutation(r.Context(), id)
	if err != nil {
		return err
	}
	if seen {
		return errDuplicate
	}
	return nil
}

func (s *Server) remember(r *http.Request) error {
	id := strings.TrimSpace(r.Header.Get("X-Client-Mutation-Id"))
	if id == "" {
		return nil
	}
	return s.Store.RememberMutation(r.Context(), id)
}

func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if allowOrigin(origin, s.Origins) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Client-Mutation-Id")
			w.Header().Set("Access-Control-Allow-Methods", "GET, PUT, DELETE, OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func allowOrigin(origin string, allowed []string) bool {
	if origin == "" {
		return false
	}
	for _, a := range allowed {
		if a == "*" || a == origin {
			return true
		}
	}
	return false
}

func readBody(r *http.Request, max int64) (json.RawMessage, error) {
	defer r.Body.Close()
	limited := io.LimitReader(r.Body, max+1)
	b, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > max {
		return nil, errString("body too large")
	}
	if !json.Valid(b) {
		return nil, errString("invalid json")
	}
	return json.RawMessage(b), nil
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	_ = enc.Encode(v)
}

func asDocList(table string, raw json.RawMessage) ([]json.RawMessage, error) {
	raw = json.RawMessage(strings.TrimSpace(string(raw)))
	if len(raw) == 0 || string(raw) == "null" {
		return []json.RawMessage{}, nil
	}
	if raw[0] == '[' {
		var docs []json.RawMessage
		if err := json.Unmarshal(raw, &docs); err != nil {
			return nil, errString(table + " must be a JSON array")
		}
		return docs, nil
	}
	if table == "distribution" && raw[0] == '{' {
		return []json.RawMessage{raw}, nil
	}
	return nil, errString(table + " must be a JSON array")
}
