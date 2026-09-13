One-line: the console's left rail — every campaign, the one-offs, then administration.

```jsx
<Sidebar>
  <SidebarSection label="Campaigns" count={4} />
  <NavItem color="var(--campaign-1)" label="Age of Umbra" meta="2d" active />
  <NavItem color="var(--campaign-idle)" label="Iron & Ivy" meta="—" />
  <SidebarSection label="Manage" />
  <NavItem label="Players" meta={17} />
</Sidebar>
```

Every row is separated by a hairline; the active row takes an inset accent bar, not a filled background alone. Campaign squares use `--campaign-1..5`; a paused or concluded campaign uses `--campaign-idle`.
