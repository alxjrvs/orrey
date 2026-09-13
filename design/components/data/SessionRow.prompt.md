One-line: the agenda's atom — when, what, who's in, and whether it runs.

```jsx
// under a DayHeader — the day is the spine, the time is a detail on the title line
<SessionRow inlineTime time="19:30"
  title="Age of Umbra · S14" subtitle="the gate under callow hill"
  attendance={{inCount:4,outCount:1,total:6,quorum:4}} state="confirmed" selected />

// flat list, no day grouping — the date earns its own column
<SessionRow when="THU 02" time="19:30" title="Age of Umbra · S14" … />
```

Session subtitles are set lower case in mono — they read as data, not prose. `state` drives the Pill; `jeopardy` is the product's word for "short of quorum with the clock running".
