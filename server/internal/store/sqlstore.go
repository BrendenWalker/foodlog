package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

type dialect int

const (
	dialectPostgres dialect = iota
	dialectSQLite
)

type SQLStore struct {
	db  *sql.DB
	d   dialect
	now func() int64
}

func newSQLStore(db *sql.DB, d dialect) *SQLStore {
	return &SQLStore{db: db, d: d, now: func() int64 { return time.Now().UnixMilli() }}
}

func (s *SQLStore) Close() error { return s.db.Close() }

func (s *SQLStore) Ping(ctx context.Context) error { return s.db.PingContext(ctx) }

func (s *SQLStore) Migrate(ctx context.Context) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS meta (
			table_name TEXT PRIMARY KEY,
			changed_ms BIGINT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS mutations (
			id TEXT PRIMARY KEY,
			applied_ms BIGINT NOT NULL
		)`,
	}
	for _, table := range Tables {
		stmts = append(stmts, fmt.Sprintf(
			`CREATE TABLE IF NOT EXISTS %s (
				id TEXT PRIMARY KEY,
				doc TEXT NOT NULL,
				updated_ms BIGINT NOT NULL
			)`, quoteIdent(table, s.d),
		))
	}
	for _, stmt := range stmts {
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	for _, table := range Tables {
		if _, err := s.db.ExecContext(ctx,
			`INSERT INTO meta (table_name, changed_ms) VALUES (`+s.ph(1)+`, 0)
			 ON CONFLICT (table_name) DO NOTHING`, table); err != nil {
			return err
		}
	}
	return nil
}

func (s *SQLStore) Meta(ctx context.Context) (Meta, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT table_name, changed_ms FROM meta`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := Meta{}
	for _, t := range Tables {
		out[t] = 0
	}
	for rows.Next() {
		var name string
		var ms int64
		if err := rows.Scan(&name, &ms); err != nil {
			return nil, err
		}
		out[name] = ms
	}
	return out, rows.Err()
}

func (s *SQLStore) List(ctx context.Context, table string) ([]json.RawMessage, error) {
	if !ValidTable(table) {
		return nil, fmt.Errorf("unknown table")
	}
	rows, err := s.db.QueryContext(ctx, `SELECT doc FROM `+quoteIdent(table, s.d)+` ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []json.RawMessage
	for rows.Next() {
		var doc string
		if err := rows.Scan(&doc); err != nil {
			return nil, err
		}
		out = append(out, json.RawMessage(doc))
	}
	if out == nil {
		out = []json.RawMessage{}
	}
	return out, rows.Err()
}

func (s *SQLStore) Put(ctx context.Context, table, id string, doc json.RawMessage) error {
	if !ValidTable(table) {
		return fmt.Errorf("unknown table")
	}
	if !json.Valid(doc) {
		return fmt.Errorf("invalid json")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	now := s.now()
	if err := s.upsertDoc(ctx, tx, table, id, string(doc), now); err != nil {
		return err
	}
	if err := s.touch(ctx, tx, table, now); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *SQLStore) Delete(ctx context.Context, table, id string) error {
	if !ValidTable(table) {
		return fmt.Errorf("unknown table")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	res, err := tx.ExecContext(ctx, `DELETE FROM `+quoteIdent(table, s.d)+` WHERE id = `+s.ph(1), id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n > 0 {
		if err := s.touch(ctx, tx, table, s.now()); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *SQLStore) ReplaceAll(ctx context.Context, table string, docs []json.RawMessage) error {
	if !ValidTable(table) {
		return fmt.Errorf("unknown table")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `DELETE FROM `+quoteIdent(table, s.d)); err != nil {
		return err
	}
	now := s.now()
	for _, doc := range docs {
		if !json.Valid(doc) {
			return fmt.Errorf("invalid json")
		}
		id, err := DocID(table, doc)
		if err != nil {
			return err
		}
		if err := s.upsertDoc(ctx, tx, table, id, string(doc), now); err != nil {
			return err
		}
	}
	if err := s.touch(ctx, tx, table, now); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *SQLStore) SeenMutation(ctx context.Context, id string) (bool, error) {
	var existing string
	err := s.db.QueryRowContext(ctx, `SELECT id FROM mutations WHERE id = `+s.ph(1), id).Scan(&existing)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

func (s *SQLStore) RememberMutation(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO mutations (id, applied_ms) VALUES (`+s.ph(1)+`, `+s.ph(2)+`)
		 ON CONFLICT (id) DO NOTHING`, id, s.now())
	return err
}

func (s *SQLStore) upsertDoc(ctx context.Context, tx *sql.Tx, table, id, doc string, now int64) error {
	q := `INSERT INTO ` + quoteIdent(table, s.d) + ` (id, doc, updated_ms) VALUES (` + s.ph(1) + `, ` + s.ph(2) + `, ` + s.ph(3) + `)
		ON CONFLICT (id) DO UPDATE SET doc = ` + s.excluded("doc") + `, updated_ms = ` + s.excluded("updated_ms")
	_, err := tx.ExecContext(ctx, q, id, doc, now)
	return err
}

func (s *SQLStore) touch(ctx context.Context, tx *sql.Tx, table string, now int64) error {
	_, err := tx.ExecContext(ctx,
		`INSERT INTO meta (table_name, changed_ms) VALUES (`+s.ph(1)+`, `+s.ph(2)+`)
		 ON CONFLICT (table_name) DO UPDATE SET changed_ms = `+s.excluded("changed_ms"),
		table, now)
	return err
}

func (s *SQLStore) ph(n int) string {
	if s.d == dialectPostgres {
		return fmt.Sprintf("$%d", n)
	}
	return "?"
}

func (s *SQLStore) excluded(col string) string {
	if s.d == dialectPostgres {
		return "EXCLUDED." + col
	}
	return "excluded." + col
}

func quoteIdent(name string, d dialect) string {
	// Table names are from a fixed allowlist; quote for camelCase foodComponents.
	if d == dialectPostgres {
		return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
	}
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}
