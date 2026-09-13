//! What models exist, what they cost and how much they hold.
//!
//! Two readers, one source. [`catalog`] keeps a models.dev snapshot in the
//! data directory; [`agents`] turns it, plus whatever each CLI says about
//! itself, into the list the node header offers (用户实测反馈 F7 and F10).

pub mod catalog;
