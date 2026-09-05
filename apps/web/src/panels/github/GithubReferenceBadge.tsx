import { Badge } from "@/ui/badge";
import { useT } from "@/app/preferences-store";
import { openGithubPanel } from "./open";
import { referenceTab, useGithubReferences } from "./references";

/**
 * The GitHub items linked to a terminal or frame node (canvas platform §4).
 *
 * Only a badge and a way back to the item: a session is not turned into a task
 * card, and nothing is drawn at all when the GitHub session is not ready.
 */
export function GithubReferenceBadge({ nodeId }: { nodeId: string }) {
  const t = useT();
  const references = useGithubReferences(nodeId);
  if (references.length === 0) return null;
  return (
    <>
      {references.map((reference) => (
        <Badge
          key={reference.referenceId}
          asChild
          variant="outline"
          className="cursor-pointer"
        >
          <button
            type="button"
            title={reference.title || t("github.reference.open")}
            aria-label={t("github.reference.open")}
            onClick={(event) => {
              event.stopPropagation();
              openGithubPanel(referenceTab(reference), reference.number);
            }}
          >
            #{String(reference.number)}
          </button>
        </Badge>
      ))}
    </>
  );
}
