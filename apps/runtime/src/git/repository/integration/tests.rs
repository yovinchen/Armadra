use super::*;
use crate::git::repository::queue::reserve_operation_slot;

fn record(id: &str, state: OperationState) -> Arc<Operation> {
    Arc::new(Operation {
        snapshot: Mutex::new(OperationSnapshot {
            id: id.into(),
            repository_id: "repository".into(),
            workspace_root: "/workspace".into(),
            repository_path: "/workspace/repo".into(),
            action: RepositoryAction::CreateBranch {
                name: "example".into(),
                start_point: None,
                switch: false,
            },
            state,
            cancellation_requested: false,
            created_at: "observed".into(),
            finished_at: Some("observed".into()),
            message: None,
        }),
        cancellation: Cancellation::default(),
        mutation_started: Arc::new(AtomicBool::new(false)),
        awaiting_resolution: AtomicBool::new(false),
    })
}

#[test]
fn live_owner_reference_survives_history_eviction_without_reordering_records() {
    let mut registry = HashMap::new();
    let mut order = VecDeque::new();
    for number in 0..MAX_OPERATIONS {
        let id = number.to_string();
        registry.insert(
            id.clone(),
            record(
                &id,
                if number == 0 {
                    OperationState::AwaitingResolution
                } else {
                    OperationState::Succeeded
                },
            ),
        );
        order.push_back(id);
    }
    let protected = std::collections::HashSet::from(["0".to_owned()]);
    reserve_operation_slot(&mut registry, &mut order, &protected, false).unwrap();
    assert!(registry.contains_key("0"));
    assert!(!registry.contains_key("1"));
    assert_eq!(order.front().map(String::as_str), Some("0"));
    assert_eq!(order.get(1).map(String::as_str), Some("2"));
    assert_eq!(registry.len(), MAX_OPERATIONS - 1);
    // Once reconciliation releases that owner, it is an ordinary terminal
    // history item and no longer permanently consumes a registry slot.
    registry.insert("new".into(), record("new", OperationState::Succeeded));
    order.push_back("new".into());
    reserve_operation_slot(&mut registry, &mut order, &Default::default(), false).unwrap();
    assert!(!registry.contains_key("0"));
}

#[test]
fn a_full_registry_of_live_owners_keeps_bounded_recovery_capacity() {
    let mut registry = HashMap::new();
    let mut order = VecDeque::new();
    let mut protected = std::collections::HashSet::new();
    for number in 0..MAX_OPERATIONS {
        let id = number.to_string();
        registry.insert(id.clone(), record(&id, OperationState::AwaitingResolution));
        order.push_back(id.clone());
        protected.insert(id);
    }
    assert!(reserve_operation_slot(&mut registry, &mut order, &protected, false).is_err());
    for number in 0..16 {
        reserve_operation_slot(&mut registry, &mut order, &protected, true).unwrap();
        let id = format!("recovery-{number}");
        registry.insert(id.clone(), record(&id, OperationState::Queued));
        order.push_back(id);
    }
    assert!(reserve_operation_slot(&mut registry, &mut order, &protected, true).is_err());
    assert!(protected.iter().all(|id| registry.contains_key(id)));
}
