One-line: the always-on footer that tells you the state of the machine, not of any one session.

```jsx
<StatusBar>
  <StatusItem label="DB" value="authoritative" />
  <StatusItem label="Open polls" value={6} />
  <StatusItem label="Next job" value="00:15" />
</StatusBar>
```

Mono, 10px, muted. Never put an action here — it is a readout.
