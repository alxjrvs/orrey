One-line: the body of every Orrey post — attendance, signup, date poll, notice, recap.

```jsx
<DiscordEmbed color="var(--campaign-1)"
  title="Age of Umbra · Session 14"
  description="Thursday 2 October, 19:30 · The Foundry"
  fields={[{name:'In (4)',value:'Rowan, Tam, Jodie, Priya'},{name:'Out (1)',value:'Marco'},{name:'No reply (1)',value:'Elle'}]}
  footer="Quorum met" asOf="as of 19:02" />
```

**Always set `asOf`** on anything that shows a tally. Posts are snapshots by design and go stale; the as-of line plus a Refresh button is how the system stays honest. Field names carry their count in parentheses. The left bar is the campaign colour; notices use amber, cancellations rust.
