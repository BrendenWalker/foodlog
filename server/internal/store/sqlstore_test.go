package store

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestSQLiteRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "t.db")
	st, err := Open("sqlite:" + path)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx := context.Background()
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	doc := json.RawMessage(`{"id":"f1","name":"Apple","calories":95}`)
	if err := st.Put(ctx, "foods", "f1", doc); err != nil {
		t.Fatal(err)
	}
	meta, err := st.Meta(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if meta["foods"] <= 0 {
		t.Fatalf("expected foods watermark, got %#v", meta)
	}
	list, err := st.List(ctx, "foods")
	if err != nil || len(list) != 1 {
		t.Fatalf("list=%v err=%v", list, err)
	}
	if err := st.Delete(ctx, "foods", "f1"); err != nil {
		t.Fatal(err)
	}
	list, err = st.List(ctx, "foods")
	if err != nil || len(list) != 0 {
		t.Fatalf("after delete list=%v err=%v", list, err)
	}
}
