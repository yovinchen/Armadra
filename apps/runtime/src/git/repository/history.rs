//! Paged commit history for the graph view.

use super::*;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRequest {
    #[serde(default = "head_ref")]
    pub reference: String,
    #[serde(default = "history_limit")]
    pub limit: usize,
    pub cursor: Option<String>,
}
fn head_ref() -> String {
    "HEAD".into()
}
fn history_limit() -> usize {
    50
}
impl Default for HistoryRequest {
    fn default() -> Self {
        Self {
            reference: head_ref(),
            limit: history_limit(),
            cursor: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRecord {
    pub oid: String,
    pub parents: Vec<String>,
    pub subject: String,
    pub author_name: String,
    pub author_email: String,
    pub author_time: String,
    pub committer_time: String,
    pub refs: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub reference: String,
    pub anchor_oid: Option<String>,
    pub commits: Vec<CommitRecord>,
    pub next_cursor: Option<String>,
    pub shallow: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HistoryCursor {
    version: u8,
    repository_id: String,
    reference: String,
    anchor_oid: String,
    offset: usize,
}

impl RepositoryService {
    pub async fn history(
        &self,
        workspace_root: &Path,
        requested: &str,
        request: HistoryRequest,
    ) -> AppResult<HistoryPage> {
        if request.limit == 0 || request.limit > MAX_HISTORY_PAGE {
            return Err(AppError::BadRequest(
                "History page size must be 1–200".into(),
            ));
        }
        let context = self.context(workspace_root, requested).await?;
        let token = Cancellation::default();
        self.validate_reference(&context.repository, &request.reference, &token)
            .await?;
        let (anchor, offset) = if let Some(cursor) = request.cursor {
            if cursor.len() > 4096 {
                return Err(invalid_cursor());
            }
            let wire = URL_SAFE_NO_PAD
                .decode(cursor)
                .map_err(|_| invalid_cursor())?;
            let cursor: HistoryCursor =
                serde_json::from_slice(&wire).map_err(|_| invalid_cursor())?;
            if cursor.version != 1
                || cursor.repository_id != context.repository_id()
                || cursor.reference != request.reference
                || !valid_oid(&cursor.anchor_oid)
                || cursor.offset > 1_000_000
            {
                return Err(invalid_cursor());
            }
            // Resolve the immutable anchor, not the ref's new value.
            (
                Some(
                    self.resolve(&context.repository, &cursor.anchor_oid, &token)
                        .await?,
                ),
                cursor.offset,
            )
        } else if request.reference == "HEAD" {
            (self.head(&context.repository, &token).await?.head_oid, 0)
        } else {
            (
                Some(
                    self.resolve(&context.repository, &request.reference, &token)
                        .await?,
                ),
                0,
            )
        };
        let shallow = one_line(
            &self
                .read(
                    &context.repository,
                    args(&["rev-parse", "--is-shallow-repository"]),
                    &token,
                )
                .await?,
        )? == "true";
        let Some(anchor_oid) = anchor else {
            return Ok(HistoryPage {
                reference: request.reference,
                anchor_oid: None,
                commits: vec![],
                next_cursor: None,
                shallow,
            });
        };
        let output = self
            .read(
                &context.repository,
                vec![
                    "log".into(),
                    "--topo-order".into(),
                    "--no-show-signature".into(),
                    "--no-decorate".into(),
                    "-z".into(),
                    "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%s".into(),
                    format!("--skip={offset}"),
                    format!("--max-count={}", request.limit + 1),
                    anchor_oid.clone(),
                    "--".into(),
                ],
                &token,
            )
            .await?;
        let refs = self.commit_refs(&context.repository, &token).await?;
        let mut commits = parse_history(&output, &refs)?;
        let more = commits.len() > request.limit;
        commits.truncate(request.limit);
        let next_cursor = if more {
            Some(
                URL_SAFE_NO_PAD.encode(
                    serde_json::to_vec(&HistoryCursor {
                        version: 1,
                        repository_id: context.repository_id(),
                        reference: request.reference.clone(),
                        anchor_oid: anchor_oid.clone(),
                        offset: offset + commits.len(),
                    })
                    .map_err(|_| malformed())?,
                ),
            )
        } else {
            None
        };
        Ok(HistoryPage {
            reference: request.reference,
            anchor_oid: Some(anchor_oid),
            commits,
            next_cursor,
            shallow,
        })
    }
}
