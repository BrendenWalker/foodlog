package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	Addr         string
	DatabaseURL  string
	SyncSecret   string
	CORSOrigins  []string
	MaxBytes     int64
}

func Load() (Config, error) {
	cfg := Config{
		Addr:        env("FOODLOG_ADDR", ":8080"),
		DatabaseURL: env("DATABASE_URL", ""),
		SyncSecret:  env("FOODLOG_SYNC_SECRET", ""),
		MaxBytes:    5 << 20,
	}
	if raw := strings.TrimSpace(os.Getenv("FOODLOG_MAX_BYTES")); raw != "" {
		n, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || n < 1024 {
			return Config{}, fmt.Errorf("FOODLOG_MAX_BYTES must be an integer >= 1024")
		}
		cfg.MaxBytes = n
	}
	if cfg.DatabaseURL == "" {
		return Config{}, fmt.Errorf("DATABASE_URL is required (postgres://... or sqlite:path.db)")
	}
	if strings.TrimSpace(cfg.SyncSecret) == "" {
		return Config{}, fmt.Errorf("FOODLOG_SYNC_SECRET is required")
	}
	if len(cfg.SyncSecret) < 4 {
		return Config{}, fmt.Errorf("FOODLOG_SYNC_SECRET must be at least 4 characters")
	}
	origins := strings.TrimSpace(os.Getenv("FOODLOG_CORS_ORIGINS"))
	if origins == "" {
		cfg.CORSOrigins = []string{"*"}
	} else {
		for _, part := range strings.Split(origins, ",") {
			part = strings.TrimSpace(part)
			if part != "" {
				cfg.CORSOrigins = append(cfg.CORSOrigins, part)
			}
		}
	}
	return cfg, nil
}

func env(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}
