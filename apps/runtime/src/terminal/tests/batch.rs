use super::super::*;

/// Plan §18.3, "输出吞吐": below the byte budget nothing goes out on its
/// own — the 16 ms timer is what releases it, and that is the batcher
/// thread's job, not the buffer's.
#[test]
fn small_writes_accumulate_instead_of_becoming_one_frame_each() {
    let mut batch = OutputBatch::new();
    for _ in 0..100 {
        assert!(batch.push(b".").is_none());
    }
    assert!(!batch.is_empty());
    let flushed = batch.take().expect("a batch");
    assert_eq!(flushed.len(), 100);
    assert!(batch.is_empty());
    assert!(batch.take().is_none());
}

/// A flood does not wait for the timer: the batch goes out the moment it
/// crosses 64 KiB, and the buffer starts over empty.
#[test]
fn the_byte_budget_flushes_without_waiting_for_the_timer() {
    let mut batch = OutputBatch::new();
    let block = vec![b'x'; 8 * 1024];
    let mut flushed = None;
    for _ in 0..8 {
        if let Some(ready) = batch.push(&block) {
            flushed = Some(ready);
        }
    }
    let flushed = flushed.expect("the eighth 8 KiB write reaches 64 KiB");
    assert_eq!(flushed.len(), OUTPUT_FLUSH_BYTES);
    assert!(batch.is_empty());
    assert!(batch.remaining().is_none());
}

/// Order is preserved across the batch boundary, and the deadline is armed
/// by the first byte rather than by the most recent one.
#[test]
fn batches_preserve_order_and_arm_the_deadline_once() {
    let mut batch = OutputBatch::new();
    assert!(batch.remaining().is_none());
    assert!(batch.push(b"he").is_none());
    let first = batch.remaining().expect("armed");
    assert!(first <= OUTPUT_FLUSH_INTERVAL);
    assert!(batch.push(b"llo").is_none());
    assert!(batch.remaining().expect("still armed") <= first);
    assert_eq!(batch.take().unwrap().as_ref(), b"hello");
}

/// The batcher thread flushes what it has and only then reports EOF, so a
/// process' last line can never arrive after its exit status.
#[test]
fn the_batcher_flushes_before_it_reports_eof() {
    use std::sync::{Arc, Mutex};

    let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let (done, wait) = std::sync::mpsc::channel::<()>();
    let sink = {
        let seen = seen.clone();
        move |chunk: Bytes| {
            seen.lock()
                .unwrap()
                .push(String::from_utf8_lossy(&chunk).into_owned());
        }
    };
    let eof = {
        let seen = seen.clone();
        move || {
            seen.lock().unwrap().push("eof".to_owned());
            let _ = done.send(());
        }
    };

    let sender = spawn_output_batcher("test", interactive_cadence(), sink, eof);
    sender.send(Bytes::from_static(b"one")).unwrap();
    sender.send(Bytes::from_static(b"two")).unwrap();
    drop(sender);

    wait.recv_timeout(Duration::from_secs(5)).expect("eof");
    let seen = seen.lock().unwrap().clone();
    assert_eq!(seen.last().map(String::as_str), Some("eof"));
    assert_eq!(seen[..seen.len() - 1].concat(), "onetwo");
}

/// Dormancy widens the deadline; it never drops or reorders bytes. The byte
/// budget still cuts a batch short, because a dormant session that suddenly
/// produces a megabyte should not hold it all in one buffer.
#[test]
fn a_dormant_cadence_only_makes_the_batch_wait_longer() {
    let mut batch = OutputBatch::new();
    batch.push(b"quiet");
    let interactive = batch.remaining().expect("armed");
    assert!(interactive <= OUTPUT_FLUSH_INTERVAL);

    batch.set_flush_interval(DORMANT_FLUSH_INTERVAL);
    let dormant = batch.remaining().expect("still armed");
    assert!(
        dormant > OUTPUT_FLUSH_INTERVAL,
        "the deadline of the batch already in flight must move too"
    );
    assert!(dormant <= DORMANT_FLUSH_INTERVAL);

    // Narrowing again takes effect at once rather than at the next batch.
    batch.set_flush_interval(OUTPUT_FLUSH_INTERVAL);
    assert!(batch.remaining().expect("armed") <= OUTPUT_FLUSH_INTERVAL);

    let flooded = batch.push(&vec![b'x'; OUTPUT_FLUSH_BYTES]);
    assert!(flooded.is_some(), "the byte budget still applies");
    assert!(flooded.unwrap().starts_with(b"quiet"));
}
