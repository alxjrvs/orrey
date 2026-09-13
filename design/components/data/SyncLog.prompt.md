One-line: the detail rail's bottom section — a plain record of projections and clicks, in the machine's own voice.

```jsx
<SyncLog entries={[
  {at:'19:02',text:'gcal event orr_5f2a updated',tone:'write'},
  {at:'18:51',text:'priya → in via button'},
  {at:'18:44',text:'50007 dm blocked, fell back to channel mention',tone:'error'}
]} />
```

Entries are lower case with no full stop, newest first, times in 24h. Arrows (→) carry state changes. Never sentence-case or humanise these — the log is the one place Orrey speaks as a system.
