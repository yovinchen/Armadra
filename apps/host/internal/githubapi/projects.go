package githubapi

import (
	"context"
	"encoding/json"
	"regexp"
)

// Projects v2 has no REST surface, so a Status field can only be read and
// written through GraphQL. A project item and the Issue it tracks are different
// objects: the item must exist before its field can be set, which is why this
// package exposes the lookup, the add and the update as three explicit steps
// rather than one opaque "move".

var nodePattern = regexp.MustCompile(`^[A-Za-z0-9_=-]{1,256}$`)

// The API has no per-project filter on projectItems, so every project the
// Issue belongs to comes back and the one being configured is selected here.
const projectItemQuery = `query($issue:ID!){node(id:$issue){... on Issue{projectItems(first:50){nodes{id project{id} fieldValues(first:50){nodes{... on ProjectV2ItemFieldSingleSelectValue{optionId field{... on ProjectV2FieldCommon{id}}}}}}}}}}`

const addProjectItemMutation = `mutation($project:ID!,$content:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$content}){item{id}}}`

const setProjectFieldMutation = `mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){projectV2Item{id}}}`

// ProjectItem is one Issue's membership of one project, with the option its
// Status field currently holds. An empty ItemID means the Issue is not on the
// project at all, which is a different repair from "on it, unset".
type ProjectItem struct {
	ItemID   string
	OptionID string
}

func validNode(values ...string) error {
	for _, value := range values {
		if !nodePattern.MatchString(value) {
			return fail(CodeInvalid, 0, "NODE_ID_INVALID")
		}
	}
	return nil
}

// ProjectItem reads the Issue's item on one project and the option its Status
// field holds. It never creates anything.
func (c *Client) ProjectItem(ctx context.Context, issueNodeID, projectID, fieldID string) (ProjectItem, error) {
	if err := validNode(issueNodeID, projectID, fieldID); err != nil {
		return ProjectItem{}, err
	}
	data, err := c.GraphQL(ctx, projectItemQuery, map[string]any{"issue": issueNodeID})
	if err != nil {
		return ProjectItem{}, err
	}
	var decoded struct {
		Node struct {
			ProjectItems struct {
				Nodes []struct {
					ID      string `json:"id"`
					Project struct {
						ID string `json:"id"`
					} `json:"project"`
					FieldValues struct {
						Nodes []struct {
							OptionID string `json:"optionId"`
							Field    struct {
								ID string `json:"id"`
							} `json:"field"`
						} `json:"nodes"`
					} `json:"fieldValues"`
				} `json:"nodes"`
			} `json:"projectItems"`
		} `json:"node"`
	}
	if err = json.Unmarshal(data, &decoded); err != nil {
		return ProjectItem{}, fail(CodeInvalid, 0, "GRAPHQL_MALFORMED")
	}
	for _, item := range decoded.Node.ProjectItems.Nodes {
		if item.Project.ID != projectID {
			continue
		}
		result := ProjectItem{ItemID: item.ID}
		for _, value := range item.FieldValues.Nodes {
			if value.Field.ID == fieldID {
				result.OptionID = value.OptionID
			}
		}
		return result, nil
	}
	return ProjectItem{}, nil
}

// AddProjectItem puts the Issue on the project. It is a separate call because
// adding an Issue to a project and setting its Status are separate effects, and
// a partly applied move has to be able to say which one happened.
func (c *Client) AddProjectItem(ctx context.Context, projectID, issueNodeID string) (string, error) {
	if err := validNode(projectID, issueNodeID); err != nil {
		return "", err
	}
	data, err := c.GraphQL(ctx, addProjectItemMutation, map[string]any{"project": projectID, "content": issueNodeID})
	if err != nil {
		return "", err
	}
	var decoded struct {
		Add struct {
			Item struct {
				ID string `json:"id"`
			} `json:"item"`
		} `json:"addProjectV2ItemById"`
	}
	if err = json.Unmarshal(data, &decoded); err != nil || decoded.Add.Item.ID == "" {
		return "", fail(CodeInvalid, 0, "GRAPHQL_MALFORMED")
	}
	return decoded.Add.Item.ID, nil
}

const projectStatusesQuery = `query($project:ID!,$after:String){node(id:$project){... on ProjectV2{items(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{content{... on Issue{number}} fieldValues(first:50){nodes{... on ProjectV2ItemFieldSingleSelectValue{optionId field{... on ProjectV2FieldCommon{id}}}}}}}}}}`

// projectStatusPages bounds one listing. A project larger than this is read
// only in part, and the Issues beyond it stay unmapped rather than being
// guessed into a group.
const projectStatusPages = 5

// ProjectStatuses reads one project's Status field for every Issue on it, so a
// page of Issues can be grouped with one query instead of one per Issue.
func (c *Client) ProjectStatuses(ctx context.Context, projectID, fieldID string) (map[int64]string, error) {
	if err := validNode(projectID, fieldID); err != nil {
		return nil, err
	}
	result := map[int64]string{}
	cursor := ""
	for page := 0; page < projectStatusPages; page++ {
		variables := map[string]any{"project": projectID}
		if cursor != "" {
			variables["after"] = cursor
		}
		data, err := c.GraphQL(ctx, projectStatusesQuery, variables)
		if err != nil {
			return nil, err
		}
		var decoded struct {
			Node struct {
				Items struct {
					PageInfo struct {
						HasNextPage bool   `json:"hasNextPage"`
						EndCursor   string `json:"endCursor"`
					} `json:"pageInfo"`
					Nodes []struct {
						Content struct {
							Number int64 `json:"number"`
						} `json:"content"`
						FieldValues struct {
							Nodes []struct {
								OptionID string `json:"optionId"`
								Field    struct {
									ID string `json:"id"`
								} `json:"field"`
							} `json:"nodes"`
						} `json:"fieldValues"`
					} `json:"nodes"`
				} `json:"items"`
			} `json:"node"`
		}
		if err = json.Unmarshal(data, &decoded); err != nil {
			return nil, fail(CodeInvalid, 0, "GRAPHQL_MALFORMED")
		}
		for _, item := range decoded.Node.Items.Nodes {
			if item.Content.Number <= 0 {
				continue
			}
			for _, value := range item.FieldValues.Nodes {
				if value.Field.ID == fieldID && value.OptionID != "" {
					result[item.Content.Number] = value.OptionID
				}
			}
		}
		if !decoded.Node.Items.PageInfo.HasNextPage || decoded.Node.Items.PageInfo.EndCursor == "" {
			break
		}
		cursor = decoded.Node.Items.PageInfo.EndCursor
	}
	return result, nil
}

func (c *Client) SetProjectField(ctx context.Context, projectID, itemID, fieldID, optionID string) error {
	if err := validNode(projectID, itemID, fieldID, optionID); err != nil {
		return err
	}
	data, err := c.GraphQL(ctx, setProjectFieldMutation, map[string]any{"project": projectID, "item": itemID, "field": fieldID, "option": optionID})
	if err != nil {
		return err
	}
	var decoded struct {
		Update struct {
			Item struct {
				ID string `json:"id"`
			} `json:"projectV2Item"`
		} `json:"updateProjectV2ItemFieldValue"`
	}
	if err = json.Unmarshal(data, &decoded); err != nil || decoded.Update.Item.ID == "" {
		return fail(CodeInvalid, 0, "GRAPHQL_MALFORMED")
	}
	return nil
}
