One-line: wraps every Orrey bot post so mockups sit in Discord's real chrome rather than Orrey's.

```jsx
<DiscordMessage timestamp="Today at 17:00">
  <DiscordEmbed title="Age of Umbra · Session 14" asOf="as of 19:02" … />
  <DiscordButtonRow buttons={[{label:"In",style:"success"},{label:"Out",style:"danger"}]} />
</DiscordMessage>
```

Inside Discord surfaces, use the `--discord-*` tokens exclusively — Orrey's slate would read as a broken theme. Orrey never edits a post it has already sent; the only rewrite is the one a button click performs on its own message.
