One-line: buttons sit on the thing they concern, and a click may rewrite its own message — this is how nearly every answer reaches Orrey.

```jsx
// attendance post
<DiscordButtonRow buttons={[
  {label:'In',style:'success'},{label:'Out',style:'danger'},
  {label:'Maybe',style:'secondary'},{label:'Note',style:'secondary'}]} />
<DiscordButtonRow buttons={[
  {label:'Suggest another day',style:'secondary'},{label:'Refresh',style:'secondary'}]} />
```

Five per row, maximum — a ten-date poll therefore needs `DiscordSelect`, not buttons. Every post that shows a tally gets a **Refresh** button, since Orrey never edits its own posts after the fact. Signup posts read "Take a seat / Waitlist / Out"; polls carry an organiser-only **Canonise**.
