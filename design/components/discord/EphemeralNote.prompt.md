One-line: wraps command replies, which are always private — this is what keeps the channel quiet.

```jsx
<EphemeralNote>
  <DiscordEmbed title="Upcoming" description="…" asOf="as of 20:14" />
</EphemeralNote>
```

Used by all four commands — `/upcoming`, `/reschedule`, `/whos-in`, `/console`. `/upcoming` replaces the idea of a pinned board: always current, no channel noise.
