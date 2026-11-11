package auth

import (
	"crypto/sha256"
	"crypto/subtle"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

type Guard struct {
	secret []byte
	mu     sync.Mutex
	fails  map[string][]time.Time
}

func New(secret string) *Guard {
	sum := sha256.Sum256([]byte(secret))
	return &Guard{secret: sum[:], fails: map[string][]time.Time{}}
}

func (g *Guard) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			next.ServeHTTP(w, r)
			return
		}
		ip := clientIP(r)
		if g.blocked(ip) {
			http.Error(w, "Too many auth failures. Try again later.", http.StatusTooManyRequests)
			return
		}
		got := bearer(r.Header.Get("Authorization"))
		if got == "" || subtle.ConstantTimeCompare(g.hash(got), g.secret) != 1 {
			g.fail(ip)
			w.Header().Set("WWW-Authenticate", `Bearer realm="foodlog"`)
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (g *Guard) hash(secret string) []byte {
	sum := sha256.Sum256([]byte(secret))
	return sum[:]
}

func (g *Guard) fail(ip string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := time.Now()
	cut := now.Add(-5 * time.Minute)
	kept := g.fails[ip][:0]
	for _, t := range g.fails[ip] {
		if t.After(cut) {
			kept = append(kept, t)
		}
	}
	g.fails[ip] = append(kept, now)
}

func (g *Guard) blocked(ip string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := time.Now()
	cut := now.Add(-5 * time.Minute)
	kept := g.fails[ip][:0]
	for _, t := range g.fails[ip] {
		if t.After(cut) {
			kept = append(kept, t)
		}
	}
	g.fails[ip] = kept
	return len(kept) >= 20
}

func bearer(header string) string {
	const prefix = "Bearer "
	if len(header) < len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return ""
	}
	return strings.TrimSpace(header[len(prefix):])
}

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		return strings.TrimSpace(parts[0])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
