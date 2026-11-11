package api_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/BrendenWalker/foodlog/server/internal/api"
	"github.com/BrendenWalker/foodlog/server/internal/auth"
)

func TestOPTIONSPreflightSucceedsWithoutAuth(t *testing.T) {
	s := &api.Server{
		Origins:  []string{"https://brendenwalker.github.io"},
		MaxBytes: 1 << 20,
	}
	h := s.CORS(auth.New("test-secret").Middleware(s.Routes()))

	req := httptest.NewRequest(http.MethodOptions, "/v1/meta", nil)
	req.Header.Set("Origin", "https://brendenwalker.github.io")
	req.Header.Set("Access-Control-Request-Method", "GET")
	req.Header.Set("Access-Control-Request-Headers", "authorization,content-type")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusNoContent {
		t.Fatalf("status=%d want 204 body=%q", rr.Code, rr.Body.String())
	}
	if got := rr.Header().Get("Access-Control-Allow-Origin"); got != "https://brendenwalker.github.io" {
		t.Fatalf("ACAO=%q", got)
	}
}

func TestUnauthorizedStillExposesCORS(t *testing.T) {
	s := &api.Server{
		Origins:  []string{"https://brendenwalker.github.io"},
		MaxBytes: 1 << 20,
	}
	h := s.CORS(auth.New("test-secret").Middleware(s.Routes()))

	req := httptest.NewRequest(http.MethodGet, "/v1/meta", nil)
	req.Header.Set("Origin", "https://brendenwalker.github.io")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d want 401", rr.Code)
	}
	if got := rr.Header().Get("Access-Control-Allow-Origin"); got != "https://brendenwalker.github.io" {
		t.Fatalf("ACAO=%q on 401", got)
	}
}
