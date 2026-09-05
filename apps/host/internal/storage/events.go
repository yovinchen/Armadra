package storage

import (
	"context"
	"database/sql"
	"errors"
)

func (s *Store) GetEvents(ctx context.Context, query EventQuery) (EventPage, error) {
	result := EventPage{Status: CursorOK, Events: []Event{}, NextCursor: query.After}
	after, err := signed(query.After)
	if err != nil {
		return result, err
	}
	limit, err := pageSize(query.Limit)
	if err != nil {
		return result, err
	}
	budget, err := pageBytes(query.ByteBudget)
	if err != nil {
		return result, err
	}
	used := 0
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	var floor, last int64
	if err = tx.QueryRowContext(ctx, "SELECT event_floor,last_sequence FROM store_meta WHERE singleton=1").Scan(&floor, &last); err != nil {
		return result, err
	}
	if floor < 0 || last < floor {
		return result, ErrCorrupt
	}
	result.MinCursor = uint64(floor)
	result.HighWatermark = uint64(last)
	if after < floor {
		result.Status = SnapshotRequired
		return result, nil
	}
	if after > last {
		result.Status = CursorAhead
		return result, nil
	}
	rows, err := tx.QueryContext(ctx, "SELECT sequence,transaction_id,operation_id,transaction_index,transaction_size,workspace_id,kind,entity_id,revision,payload,deleted FROM events WHERE sequence>? ORDER BY sequence LIMIT ?", after, limit+1)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		if len(result.Events) == limit || (len(result.Events) > 0 && used >= budget) {
			result.HasMore = true
			break
		}
		var event Event
		var sequence, transaction, revision int64
		var deleted int
		err = rows.Scan(&sequence, &transaction, &event.OperationID, &event.TransactionIndex, &event.TransactionSize, &event.WorkspaceID, &event.Kind, &event.ID, &revision, &event.Payload, &deleted)
		if err != nil {
			rows.Close()
			return result, err
		}
		if sequence < 1 || transaction < 1 || revision < 1 || event.TransactionIndex < 0 || event.TransactionIndex >= event.TransactionSize || (deleted != 0 && deleted != 1) {
			rows.Close()
			return result, ErrCorrupt
		}
		event.Sequence = uint64(sequence)
		event.TransactionID = uint64(transaction)
		event.Revision = uint64(revision)
		event.Deleted = deleted == 1
		size := entityBytes(event.Entity) + len(event.OperationID) + 64
		if len(result.Events) > 0 && used+size > budget {
			result.HasMore = true
			break
		}
		used += size
		result.Events = append(result.Events, event)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}

	if result.HasMore {
		result.NextCursor = result.Events[len(result.Events)-1].Sequence
	} else {
		result.NextCursor = uint64(last)
	}
	if err = tx.Commit(); err != nil {
		return result, err
	}
	return result, nil
}

// PruneEvents advances the retention floor only at a complete transaction
// boundary. It never removes idempotency receipts or entity tombstones.
func (s *Store) PruneEvents(ctx context.Context, through uint64) error {
	sequence, err := signed(through)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var floor, last int64
	if err = tx.QueryRowContext(ctx, "SELECT event_floor,last_sequence FROM store_meta WHERE singleton=1").Scan(&floor, &last); err != nil {
		return err
	}
	if floor < 0 || last < floor {
		return ErrCorrupt
	}
	if sequence <= floor {
		return nil
	}
	if sequence > last {
		return ErrInvalid
	}
	var index, size int
	if err = tx.QueryRowContext(ctx, "SELECT transaction_index,transaction_size FROM events WHERE sequence=?", sequence).Scan(&index, &size); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrCorrupt
		}
		return err
	}
	if size < 1 || index != size-1 {
		return ErrInvalid
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM events WHERE sequence<=?", sequence); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE store_meta SET event_floor=? WHERE singleton=1", sequence); err != nil {
		return err
	}
	return tx.Commit()
}
