package store

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
)

// Table names match the PWA sync surface.
var Tables = []string{
	"foods",
	"foodComponents",
	"entries",
	"targets",
	"weights",
	"categories",
	"distribution",
}

type Meta map[string]int64

// Store is the DB-agnostic persistence surface for sync.
type Store interface {
	Close() error
	Ping(ctx context.Context) error
	Migrate(ctx context.Context) error
	Meta(ctx context.Context) (Meta, error)

	List(ctx context.Context, table string) ([]json.RawMessage, error)
	Put(ctx context.Context, table, id string, doc json.RawMessage) error
	Delete(ctx context.Context, table, id string) error
	ReplaceAll(ctx context.Context, table string, docs []json.RawMessage) error

	SeenMutation(ctx context.Context, id string) (bool, error)
	RememberMutation(ctx context.Context, id string) error
}

func Open(databaseURL string) (Store, error) {
	raw := strings.TrimSpace(databaseURL)
	if raw == "" {
		return nil, fmt.Errorf("empty DATABASE_URL")
	}
	if strings.HasPrefix(raw, "sqlite:") {
		path := strings.TrimPrefix(raw, "sqlite:")
		if path == "" {
			return nil, fmt.Errorf("sqlite path is empty")
		}
		return openSQLite(path)
	}
	u, err := url.Parse(raw)
	if err == nil && (u.Scheme == "postgres" || u.Scheme == "postgresql") {
		return openPostgres(raw)
	}
	if strings.HasPrefix(raw, "file:") || strings.HasSuffix(raw, ".db") || strings.HasSuffix(raw, ".sqlite") {
		path := strings.TrimPrefix(raw, "file:")
		return openSQLite(path)
	}
	return nil, fmt.Errorf("unsupported DATABASE_URL (use postgres://... or sqlite:./foodlog.db)")
}

func ValidTable(name string) bool {
	for _, t := range Tables {
		if t == name {
			return true
		}
	}
	return false
}

func DocID(table string, doc json.RawMessage) (string, error) {
	if table == "distribution" {
		return "distribution", nil
	}
	if table == "categories" {
		var row struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(doc, &row); err != nil || strings.TrimSpace(row.ID) == "" {
			return "", fmt.Errorf("category is missing id")
		}
		return row.ID, nil
	}
	if table == "targets" {
		var row struct {
			EffectiveDate string `json:"effectiveDate"`
		}
		if err := json.Unmarshal(doc, &row); err != nil || strings.TrimSpace(row.EffectiveDate) == "" {
			return "", fmt.Errorf("target is missing effectiveDate")
		}
		return row.EffectiveDate, nil
	}
	if table == "weights" {
		var row struct {
			DateKey string `json:"dateKey"`
		}
		if err := json.Unmarshal(doc, &row); err != nil || strings.TrimSpace(row.DateKey) == "" {
			return "", fmt.Errorf("weight is missing dateKey")
		}
		return row.DateKey, nil
	}
	var row struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(doc, &row); err != nil || strings.TrimSpace(row.ID) == "" {
		return "", fmt.Errorf("%s row is missing id", table)
	}
	return row.ID, nil
}
