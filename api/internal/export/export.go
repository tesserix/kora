package export

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// FormatVersion identifies the export's shape.
//
// Bump it when the envelope changes in a way a consumer could trip on —
// a renamed top-level key, a moved field. Adding a table or a column does NOT
// bump it: those arrive continuously by design (see the package doc), and a
// version that changes on every migration tells a reader nothing.
const FormatVersion = 1

// Redaction is one withheld value, as it appears in the export.
type Redaction struct {
	Table  string `json:"table"`
	Column string `json:"column"`
	Reason string `json:"reason"`
}

// Document is one user's complete export.
//
// Data is a map rather than a struct for the reason the package doc gives:
// nothing here mirrors the schema, so nothing here can fall behind it.
type Document struct {
	FormatVersion int    `json:"format_version"`
	ExportedAt    string `json:"exported_at"`
	UserID        string `json:"user_id"`
	// Redacted lists what was withheld and why. Present and populated even
	// when the affected row does not exist for this user — the statement is
	// about the export's rules, not about this user's data, and a reader
	// comparing two exports should not see the rules appear and disappear.
	Redacted []Redaction `json:"redacted"`
	// Counts is rows per table, including the zeroes. A table absent from
	// this map would be ambiguous between "you have none" and "we did not
	// look"; §4.5's lesson, applied to a file instead of an endpoint.
	Counts map[string]int `json:"counts"`
	// Tables is table name -> rows. Every table in export.Tables is present,
	// with an empty array when the user has no rows, for the same reason.
	//
	// The JSON key is "tables", NOT "data", and that is load-bearing rather
	// than stylistic. The mobile client's apiFetch returns
	// `envelope.data ?? envelope` — the repo-wide convention for unwrapping
	// httpx.OK. A top-level "data" here would be indistinguishable from that
	// envelope, so the client would silently receive the table map alone and
	// drop format_version, exported_at, counts and redacted, with nothing
	// failing anywhere. Do not rename this to "data".
	Tables map[string][]map[string]any `json:"tables"`
}

// Service reads exports.
type Service struct {
	db  *gorm.DB
	now func() time.Time
}

// NewService builds the service.
func NewService(db *gorm.DB) Service {
	return Service{db: db, now: time.Now}
}

// ForUser reads every table in Tables, scoped to userID.
//
// It runs each table as its own query rather than one transaction-wide join,
// and deliberately NOT inside a transaction: an export is a snapshot for a
// human, not an accounting record, and holding a read transaction open across
// ~40 queries on a db-f1-micro shared by every service is a worse trade than
// a row written midway through appearing in one table and not another.
//
// Any table failing fails the whole export. A partial export is
// indistinguishable from a complete one once it is a file on someone's disk —
// the same argument mark8ly's KPI handler makes for refusing partial results.
func (s Service) ForUser(ctx context.Context, userID uuid.UUID) (Document, error) {
	redactions := redactionIndex()

	doc := Document{
		FormatVersion: FormatVersion,
		ExportedAt:    s.now().UTC().Format(time.RFC3339),
		UserID:        userID.String(),
		Redacted:      declaredRedactions(),
		Counts:        make(map[string]int, len(Tables)),
		Tables:        make(map[string][]map[string]any, len(Tables)),
	}

	for _, t := range Tables {
		rows, err := s.readTable(ctx, t, userID, redactions[t.Name])
		if err != nil {
			return Document{}, fmt.Errorf("export: %s: %w", t.Name, err)
		}
		doc.Tables[t.Name] = rows
		doc.Counts[t.Name] = len(rows)
	}
	return doc, nil
}

func declaredRedactions() []Redaction {
	out := make([]Redaction, 0, len(RedactedColumns))
	for _, r := range RedactedColumns {
		out = append(out, Redaction{Table: r.Table, Column: r.Column, Reason: r.Reason})
	}
	return out
}

// readTable reads one table's rows for this user.
func (s Service) readTable(ctx context.Context, t Table, userID uuid.UUID, redacted map[string]struct{}) ([]map[string]any, error) {
	args := make([]any, t.Args)
	for i := range args {
		args[i] = userID
	}

	var rows []map[string]any
	// Table+Where are compile-time constants from tables.go; only userID is
	// bound, and it is bound as a parameter.
	if err := s.db.WithContext(ctx).
		Table(t.Name).
		Where(t.Where, args...).
		Find(&rows).Error; err != nil {
		return nil, err
	}

	// Never nil: an empty table must serialise as [] so a consumer's
	// iteration does not have to special-case it.
	out := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		out = append(out, cleanRow(row, redacted))
	}
	return out, nil
}

// cleanRow drops redacted columns and makes the remaining values marshal as
// what they are.
func cleanRow(row map[string]any, redacted map[string]struct{}) map[string]any {
	out := make(map[string]any, len(row))
	for k, v := range row {
		if _, hidden := redacted[k]; hidden {
			// Dropped, not nulled. A null is indistinguishable from a column
			// the user genuinely has no value for; the Redacted list is where
			// a reader learns this field exists at all.
			continue
		}
		out[k] = marshalable(v)
	}
	return out
}

// marshalable converts a driver value into something encoding/json renders
// honestly.
//
// The case that matters is []byte. Go's json encoder base64-encodes it, so a
// jsonb column — coach turn payloads, admin snapshots, serving_units — would
// land in the export as an opaque base64 blob rather than as the structure it
// is. A user opening their export would find their own data unreadable and
// have no way to know it was JSON underneath.
func marshalable(v any) any {
	b, ok := v.([]byte)
	if !ok {
		return v
	}
	if json.Valid(b) {
		return json.RawMessage(b)
	}
	// Not JSON: a text column the driver handed back as bytes. A string is
	// still right; genuinely binary columns would be mangled here, and there
	// are none in the exported set — the completeness test's table list is
	// what would surface one.
	return string(b)
}
