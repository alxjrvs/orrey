One-line: the detail rail's per-person line, and the surface the organiser corrects attendance on.

```jsx
<RosterRow name="Rowan" initials="RW" role="GM" intent="in" />
<RosterRow name="Marco" initials="MC" intent="out" note="work" />
<RosterRow name="Elle" initials="EL" intent="silent" />
<RosterRow name="Tam" initials="TK" intent="in" attended />
```

Avatars are square, initials in mono — there are no photographs anywhere in Orrey. Before a session, show `intent` only; after it, add `attended`, which Orrey auto-assumes from intent and the organiser toggles.
