package storage

// A committed transaction is the only moment new sequences exist. Anything that
// pushes events to a client has to learn about it from here rather than by
// polling the watermark, or the delay a subscriber sees is the poll interval
// instead of the write.
//
// The notifier is called after the commit succeeds, never inside the
// transaction: a listener that blocks must not be able to hold the write lock,
// and a listener that panics must not roll back a transaction that already
// committed. It receives the last sequence the transaction published, so a
// listener can tell "there is new work" from "someone re-read the same state".

// SetCommitNotifier installs the callback run after each committed transaction.
// Passing nil removes it. It is set once during assembly, before the store
// serves requests; it is not safe to swap while writes are in flight.
func (s *Store) SetCommitNotifier(notify func(sequence uint64)) {
	s.notify = notify
}

// committed runs the notifier without letting it take the caller down.
func (s *Store) committed(sequence uint64) {
	notify := s.notify
	if notify == nil || sequence == 0 {
		return
	}
	defer func() { _ = recover() }()
	notify(sequence)
}
