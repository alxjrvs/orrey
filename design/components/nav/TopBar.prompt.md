One-line: the console's fixed top chrome, holding the wordmark, a version Tag, and the sync chips.

```jsx
<TopBar>
  <Wordmark />
  <Tag>SCHEDULER v0.4</Tag>
  <div style={{marginLeft:'auto',display:'flex'}}>
    <SyncChip label="Discord OK" />
    <SyncChip label="GCal 4m ago" />
  </div>
</TopBar>
```

There is no logo file — `Wordmark` sets the name in Space Grotesk with a signal-coloured interpunct. Never substitute an invented mark.
