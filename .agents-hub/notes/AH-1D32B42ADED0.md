---
{
  "version": 1,
  "id": "AH-1D32B42ADED0",
  "kind": "context",
  "title": "get rid of the node detail modal and instead make everything editable on the node within the canvas - user clicks a node, then can change type, text, detail etc",
  "createdAt": "2026-09-24T11:29:04.843Z",
  "updatedAt": "2026-09-24T20:06:42.661Z",
  "updatedBy": "person",
  "sectionId": "SC-E25F55449B87",
  "links": [
    {
      "to": "AH-889FBF96E237",
      "kind": "learned_from"
    }
  ],
  "images": [],
  "userSource": {
    "title": "get rid of the node detail modal and instead make everything editable on the node within the canvas - user clicks a node, then can change type, text, detail etc",
    "body": "The canvas keeps browsing cards at a fixed size and anchors a scrollable editor to the selected card, so layout geometry stays stable during editing."
  },
  "subject": "get rid of the node detail modal and instead make everything editable on the node within the canvas - user clicks a node, then can change type, text, detail etc",
  "evidence": [
    {
      "path": "src/BoardCanvas.tsx"
    },
    {
      "path": "src/board.css"
    }
  ],
  "sourceTaskIds": [
    "AH-889FBF96E237"
  ],
  "verifiedAt": "2026-09-24T11:29:04.843Z",
  "presentationHash": "0a088052132846a18f90ac401908311f79026669e580b093203e1f3c981d25b6"
}
---
The canvas keeps browsing cards at a fixed size and anchors a scrollable editor to the selected card, so layout geometry stays stable during editing.
