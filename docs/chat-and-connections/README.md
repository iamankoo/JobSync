# Connections and Group Chat

Both features use the existing Google Sheets store (no new service or account). Five optional tabs, created once, additive only
(`node --conditions=react-server --experimental-strip-types --no-warnings scripts/add-prod-tabs.mts` does it and proves existing tabs are unchanged):

| Tab | Headers |
|---|---|
| `Connections` | ConnectionID, MemberID, Name, Company, Role, ProfileUrl, OtherUrl, Message, Notes, Status, CreatedAt, UpdatedAt |
| `ChatMessages` | MessageID, MemberID, Kind, Text, FileID, FileName, MimeType, SizeBytes, DurationSec, CreatedAt |
| `ChatFiles` | FileID, Seq, Data |
| `ChatReads` | MemberID, LastReadRow, UpdatedAt |
| `CallSignals` | SignalID, CallID, FromMemberID, ToMemberID, Type, Payload, CreatedAt |

## Connections (shared)

One shared list, like Jobs: every member sees every entry with person, company/role, profile links, the message to forward, status, who added it and when. Statuses: Not Connected, Connected, Messaged, Reply. Only the member who added an entry can edit, change the status of, or delete it (others get 403). JobSync never contacts LinkedIn or anyone; it only tracks and lets you copy the message.

## Group Chat (Anni, Lukky, Rishii only)

- Text, timestamps, sender identity, auto-scroll, unread badge (sidebar / mobile menu dot) and a "New messages" divider.
- **Updates use short polling** (about every 3 s while the page is visible, plus a shared 2.5 s server read cache): expect roughly 3-5 s latency. A Vercel function cannot hold a WebSocket and Google Sheets is the only store. Instant delivery would need a realtime service (a new account), which was deliberately not added.
- **Attachments**: images (PNG/JPEG/GIF/WebP), PDF, audio, Office documents, text/CSV, ZIP; **max 2 MB**; checked by content (magic bytes) and extension on both browser and server; SVG/HTML/scripts/executables are refused; max 20 uploads / 10 min / member. Bytes are base64 chunks (40,000 chars per cell) in `ChatFiles` and are only served by `/api/chat/files/<id>` to a signed-in active member, via a posted message, with `nosniff` and a sandbox CSP (no public URL, no credentials in the browser). Voice notes: up to 3 minutes, recorded with the browser's MediaRecorder.
- **Calls**: browser-to-browser WebRTC, up to the three members as a mesh; the app only relays small offers/answers (`/api/chat/call`, polled about every 1.5 s during a call) and pings; media never touches the server. Starting a call posts a chat line and a push notification to the other two. Only public STUN servers are used: **no TURN relay**, so members on networks that block direct peer-to-peer traffic (some corporate or carrier-grade NAT networks) will see "Couldn't connect". Automated tests exercised real WebRTC only with Chromium's fake camera/microphone; real-device reliability is not established. Calls need https and microphone/camera permission; denied, missing or busy devices show a specific message.
- Sheets quota: reads are shared/cached and polling pauses while the tab is hidden; heavy simultaneous use by all three could approach Google's per-minute read quota.
- Retention: chat history, files and the other tabs are not pruned automatically (call signals older than 24 h are removed when a new call starts).
