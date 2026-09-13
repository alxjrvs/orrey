/* @ds-bundle: {"format":4,"namespace":"OrreyDesignSystem_4c8cbd","components":[{"name":"Button","sourcePath":"components/core/Button.jsx"},{"name":"Checkbox","sourcePath":"components/core/Checkbox.jsx"},{"name":"Field","sourcePath":"components/core/Field.jsx"},{"name":"Input","sourcePath":"components/core/Field.jsx"},{"name":"Panel","sourcePath":"components/core/Panel.jsx"},{"name":"Pill","sourcePath":"components/core/Pill.jsx"},{"name":"Select","sourcePath":"components/core/Select.jsx"},{"name":"Tag","sourcePath":"components/core/Tag.jsx"},{"name":"DataTable","sourcePath":"components/data/DataTable.jsx"},{"name":"Cell","sourcePath":"components/data/DataTable.jsx"},{"name":"DayHeader","sourcePath":"components/data/DayHeader.jsx"},{"name":"QuorumMeter","sourcePath":"components/data/QuorumMeter.jsx"},{"name":"Avatar","sourcePath":"components/data/RosterRow.jsx"},{"name":"RosterRow","sourcePath":"components/data/RosterRow.jsx"},{"name":"SessionRow","sourcePath":"components/data/SessionRow.jsx"},{"name":"SyncLog","sourcePath":"components/data/SyncLog.jsx"},{"name":"DiscordButtonRow","sourcePath":"components/discord/DiscordButtonRow.jsx"},{"name":"DiscordEmbed","sourcePath":"components/discord/DiscordEmbed.jsx"},{"name":"DiscordMessage","sourcePath":"components/discord/DiscordMessage.jsx"},{"name":"DiscordSelect","sourcePath":"components/discord/DiscordSelect.jsx"},{"name":"EphemeralNote","sourcePath":"components/discord/EphemeralNote.jsx"},{"name":"SegmentedFilter","sourcePath":"components/nav/SegmentedFilter.jsx"},{"name":"Sidebar","sourcePath":"components/nav/Sidebar.jsx"},{"name":"SidebarSection","sourcePath":"components/nav/Sidebar.jsx"},{"name":"NavItem","sourcePath":"components/nav/Sidebar.jsx"},{"name":"StatusBar","sourcePath":"components/nav/StatusBar.jsx"},{"name":"StatusItem","sourcePath":"components/nav/StatusBar.jsx"},{"name":"SyncChip","sourcePath":"components/nav/SyncChip.jsx"},{"name":"TopBar","sourcePath":"components/nav/TopBar.jsx"},{"name":"Wordmark","sourcePath":"components/nav/TopBar.jsx"}],"sourceHashes":{"components/core/Button.jsx":"e671bf93601a","components/core/Checkbox.jsx":"8e4af7771f58","components/core/Field.jsx":"28497f1aeaac","components/core/Panel.jsx":"e590db7cabfa","components/core/Pill.jsx":"26f3235038f3","components/core/Select.jsx":"ef86d9a7d5c7","components/core/Tag.jsx":"70651fc6b174","components/data/DataTable.jsx":"1c6e0349cf64","components/data/DayHeader.jsx":"501bb93d4df1","components/data/QuorumMeter.jsx":"88394772f95c","components/data/RosterRow.jsx":"16dcd5d8503f","components/data/SessionRow.jsx":"c8f668c7dd18","components/data/SyncLog.jsx":"e4e56dbaeed1","components/discord/DiscordButtonRow.jsx":"cdcb45db8be1","components/discord/DiscordEmbed.jsx":"2947481f52d9","components/discord/DiscordMessage.jsx":"85f7f5d1816b","components/discord/DiscordSelect.jsx":"13dcbfafc9b6","components/discord/EphemeralNote.jsx":"e032b30b00f6","components/nav/SegmentedFilter.jsx":"898f5f8d37d2","components/nav/Sidebar.jsx":"e32500bd6bb7","components/nav/StatusBar.jsx":"6df187ad2a96","components/nav/SyncChip.jsx":"e73269fddcd2","components/nav/TopBar.jsx":"98f466912741","ui_kits/console/Agenda.jsx":"f1f3b2a1ef9f","ui_kits/console/CampaignPage.jsx":"d8b665972c5c","ui_kits/console/ConsoleApp.jsx":"51215dd27b78","ui_kits/console/DetailRail.jsx":"72f4d0cfa69c","ui_kits/console/PlayersPage.jsx":"fe4edad79e64","ui_kits/console/PollPage.jsx":"4d068c157dfa","ui_kits/console/data.js":"7327911738b7","ui_kits/discord/Chrome.jsx":"4754bf19ec8d","ui_kits/discord/DiscordApp.jsx":"490a4090a78a","ui_kits/discord/Posts.jsx":"c17722d835dc","ui_kits/discord/data.js":"a92ccebf0f5d","ui_kits/entry/EntryApp.jsx":"46271282368f","ui_kits/entry/Screens.jsx":"31a6c84a7ead"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.OrreyDesignSystem_4c8cbd = window.OrreyDesignSystem_4c8cbd || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/core/Button.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const base = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 'var(--space-3)',
  border: '1px solid transparent',
  borderRadius: 'var(--radius-none)',
  cursor: 'pointer',
  fontFamily: 'var(--font-mono)',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: 'var(--tracking-data)',
  whiteSpace: 'nowrap',
  transition: 'var(--transition-hover)'
};
const sizes = {
  sm: {
    height: 'var(--control-sm)',
    padding: '0 var(--space-5)',
    fontSize: 'var(--size-micro)',
    letterSpacing: '0.12em'
  },
  md: {
    height: 'var(--control-md)',
    padding: '0 var(--space-6)',
    fontSize: 'var(--size-label)',
    letterSpacing: '0.09em'
  },
  lg: {
    height: 'var(--control-lg)',
    padding: '0 var(--space-8)',
    fontSize: 'var(--size-data)',
    letterSpacing: '0.09em'
  }
};
const variants = {
  primary: {
    background: 'var(--action-bg)',
    color: 'var(--action-ink)'
  },
  secondary: {
    background: 'transparent',
    borderColor: 'var(--line-structural)',
    color: 'var(--text-primary)'
  },
  ghost: {
    background: 'transparent',
    color: 'var(--text-secondary)'
  },
  danger: {
    background: 'transparent',
    borderColor: 'var(--state-out-line)',
    color: 'var(--state-out-text)'
  }
};
const hovers = {
  primary: {
    background: 'var(--action-bg-hover)'
  },
  secondary: {
    background: 'var(--surface-raised)',
    borderColor: 'var(--line-strong)'
  },
  ghost: {
    background: 'var(--surface-raised)',
    color: 'var(--text-primary)'
  },
  danger: {
    background: 'var(--state-out-bg)',
    borderColor: 'var(--state-out)'
  }
};
function Button({
  variant = 'secondary',
  size = 'md',
  disabled = false,
  full = false,
  children,
  style,
  ...rest
}) {
  const [hot, setHot] = React.useState(false);
  return /*#__PURE__*/React.createElement("button", _extends({
    type: "button",
    disabled: disabled,
    onMouseEnter: () => setHot(true),
    onMouseLeave: () => setHot(false),
    style: {
      ...base,
      ...sizes[size],
      ...variants[variant],
      ...(hot && !disabled ? hovers[variant] : null),
      width: full ? '100%' : undefined,
      opacity: disabled ? 0.4 : 1,
      cursor: disabled ? 'not-allowed' : 'pointer',
      ...style
    }
  }, rest), children);
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Button.jsx", error: String((e && e.message) || e) }); }

// components/core/Checkbox.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function Checkbox({
  checked = false,
  label,
  onChange,
  disabled = false,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("label", _extends({
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 'var(--space-5)',
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.4 : 1,
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("span", {
    onClick: () => !disabled && onChange && onChange(!checked),
    style: {
      width: 14,
      height: 14,
      flex: 'none',
      display: 'grid',
      placeItems: 'center',
      border: '1px solid ' + (checked ? 'var(--signal-500)' : 'var(--line-strong)'),
      background: checked ? 'var(--signal-500)' : 'var(--surface-sunken)',
      transition: 'var(--transition-hover)'
    }
  }, checked && /*#__PURE__*/React.createElement("i", {
    style: {
      width: 6,
      height: 3,
      borderLeft: '1.5px solid var(--action-ink)',
      borderBottom: '1.5px solid var(--action-ink)',
      transform: 'rotate(-45deg) translate(0.5px,-1px)'
    }
  })), label && /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-body)'
    }
  }, label));
}
Object.assign(__ds_scope, { Checkbox });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Checkbox.jsx", error: String((e && e.message) || e) }); }

// components/core/Field.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function Field({
  label,
  hint,
  error,
  required = false,
  children,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("label", _extends({
    style: {
      display: 'block',
      ...style
    }
  }, rest), label && /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      gap: 'var(--space-3)',
      alignItems: 'baseline',
      font: 'var(--type-label)',
      letterSpacing: 'var(--tracking-label)',
      textTransform: 'uppercase',
      color: 'var(--text-muted)',
      marginBottom: 'var(--space-4)'
    }
  }, label, required && /*#__PURE__*/React.createElement("i", {
    style: {
      color: 'var(--signal-500)',
      fontStyle: 'normal'
    }
  }, "*")), children, (hint || error) && /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      marginTop: 'var(--space-3)',
      font: 'var(--type-small)',
      color: error ? 'var(--state-out-text)' : 'var(--text-muted)'
    }
  }, error || hint));
}
function Input({
  invalid = false,
  style,
  ...rest
}) {
  const [hot, setHot] = React.useState(false);
  return /*#__PURE__*/React.createElement("input", _extends({
    onFocus: () => setHot(true),
    onBlur: () => setHot(false),
    style: {
      width: '100%',
      height: 'var(--control-md)',
      padding: '0 var(--space-5)',
      background: 'var(--surface-sunken)',
      color: 'var(--text-primary)',
      border: '1px solid ' + (invalid ? 'var(--state-out-line)' : hot ? 'var(--signal-500)' : 'var(--line-structural)'),
      borderRadius: 'var(--radius-none)',
      font: 'var(--type-body)',
      outline: 'none',
      transition: 'var(--transition-hover)',
      ...style
    }
  }, rest));
}
Object.assign(__ds_scope, { Field, Input });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Field.jsx", error: String((e && e.message) || e) }); }

// components/core/Panel.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function Panel({
  title,
  meta,
  actions,
  flush = false,
  children,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("section", _extends({
    style: {
      border: '1px solid var(--line-structural)',
      background: 'var(--surface-chrome)',
      borderRadius: 'var(--radius-none)',
      ...style
    }
  }, rest), (title || actions) && /*#__PURE__*/React.createElement("header", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--space-6)',
      padding: 'var(--space-5) var(--space-7)',
      borderBottom: '1px solid var(--line-structural)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-label)',
      letterSpacing: 'var(--tracking-label)',
      textTransform: 'uppercase',
      color: 'var(--text-muted)'
    }
  }, title), meta && /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-data)',
      fontWeight: 400,
      color: 'var(--text-secondary)'
    }
  }, meta), actions && /*#__PURE__*/React.createElement("div", {
    style: {
      marginLeft: 'auto',
      display: 'flex',
      gap: 'var(--space-3)'
    }
  }, actions)), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: flush ? 0 : 'var(--space-7)'
    }
  }, children));
}
Object.assign(__ds_scope, { Panel });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Panel.jsx", error: String((e && e.message) || e) }); }

// components/core/Pill.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const tones = {
  neutral: {
    color: 'var(--text-secondary)',
    borderColor: 'var(--line-structural)',
    background: 'transparent'
  },
  in: {
    color: 'var(--state-in-text)',
    borderColor: 'var(--state-in-line)',
    background: 'var(--state-in-bg)'
  },
  maybe: {
    color: 'var(--state-maybe-text)',
    borderColor: 'var(--state-maybe-line)',
    background: 'var(--state-maybe-bg)'
  },
  out: {
    color: 'var(--state-out-text)',
    borderColor: 'var(--state-out-line)',
    background: 'var(--state-out-bg)'
  },
  accent: {
    color: 'var(--signal-400)',
    borderColor: 'var(--signal-600)',
    background: 'var(--signal-100)'
  },
  idle: {
    color: 'var(--text-muted)',
    borderColor: 'var(--line-hair)',
    background: 'transparent'
  }
};
function Pill({
  tone = 'neutral',
  dot = false,
  children,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("span", _extends({
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 'var(--space-3)',
      font: 'var(--type-micro)',
      letterSpacing: '0.12em',
      textTransform: 'uppercase',
      padding: '5px 9px',
      borderRadius: 'var(--radius-pill)',
      border: '1px solid',
      ...tones[tone],
      ...style
    }
  }, rest), dot && /*#__PURE__*/React.createElement("i", {
    style: {
      width: 5,
      height: 5,
      borderRadius: 'var(--radius-circle)',
      background: 'currentColor'
    }
  }), children);
}
Object.assign(__ds_scope, { Pill });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Pill.jsx", error: String((e && e.message) || e) }); }

// components/core/Select.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function Select({
  options = [],
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      ...style
    }
  }, /*#__PURE__*/React.createElement("select", _extends({
    style: {
      width: '100%',
      height: 'var(--control-md)',
      padding: '0 26px 0 var(--space-5)',
      background: 'var(--surface-sunken)',
      color: 'var(--text-primary)',
      border: '1px solid var(--line-structural)',
      borderRadius: 'var(--radius-none)',
      font: 'var(--type-body)',
      appearance: 'none',
      outline: 'none',
      cursor: 'pointer'
    }
  }, rest), options.map(o => {
    const v = typeof o === 'string' ? o : o.value,
      l = typeof o === 'string' ? o : o.label;
    return /*#__PURE__*/React.createElement("option", {
      key: v,
      value: v
    }, l);
  })), /*#__PURE__*/React.createElement("i", {
    style: {
      position: 'absolute',
      right: 9,
      top: '50%',
      marginTop: -2,
      width: 0,
      height: 0,
      borderLeft: '4px solid transparent',
      borderRight: '4px solid transparent',
      borderTop: '4px solid var(--text-muted)',
      pointerEvents: 'none'
    }
  }));
}
Object.assign(__ds_scope, { Select });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Select.jsx", error: String((e && e.message) || e) }); }

// components/core/Tag.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function Tag({
  mono = true,
  children,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("span", _extends({
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      padding: '4px 6px',
      border: '1px solid var(--line-structural)',
      borderRadius: 'var(--radius-none)',
      font: mono ? 'var(--type-label)' : 'var(--type-small)',
      fontWeight: 500,
      letterSpacing: 'var(--tracking-data)',
      color: 'var(--text-muted)',
      ...style
    }
  }, rest), children);
}
Object.assign(__ds_scope, { Tag });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Tag.jsx", error: String((e && e.message) || e) }); }

// components/data/DataTable.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function DataTable({
  columns = [],
  children,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("table", _extends({
    style: {
      width: '100%',
      borderCollapse: 'collapse',
      borderTop: '1px solid var(--line-structural)',
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, columns.map((c, i) => /*#__PURE__*/React.createElement("th", {
    key: i,
    style: {
      width: c.width,
      textAlign: c.align || 'left',
      font: 'var(--type-micro)',
      letterSpacing: 'var(--tracking-label)',
      textTransform: 'uppercase',
      color: 'var(--text-muted)',
      padding: 'var(--space-4) var(--space-5)',
      background: 'var(--surface-chrome)',
      borderBottom: '1px solid var(--line-structural)'
    }
  }, c.label)))), /*#__PURE__*/React.createElement("tbody", null, children));
}
function Cell({
  children,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("td", _extends({
    style: {
      padding: 'var(--space-4) var(--space-5)',
      verticalAlign: 'middle',
      ...style
    }
  }, rest), children);
}
Object.assign(__ds_scope, { DataTable, Cell });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/DataTable.jsx", error: String((e && e.message) || e) }); }

// components/data/DayHeader.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function DayHeader({
  day,
  relative,
  lead,
  gutter = 86,
  colSpan = 4,
  asRow = true,
  style,
  ...rest
}) {
  const inner = /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: gutter + 'px 1fr',
      alignItems: 'center',
      background: 'var(--surface-chrome)',
      borderTop: '1px solid var(--line-structural)',
      borderBottom: '1px solid var(--line-structural)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 'var(--space-5) var(--space-5)',
      textAlign: 'left',
      font: 'var(--font-mono)',
      fontWeight: 700,
      fontSize: 'var(--size-title)',
      lineHeight: 1,
      color: 'var(--text-primary)',
      borderRight: '1px solid var(--line-hair)'
    }
  }, lead), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 'var(--space-5)',
      padding: 'var(--space-5) var(--space-5)'
    }
  }, /*#__PURE__*/React.createElement("b", {
    style: {
      font: 'var(--type-label)',
      fontSize: 'var(--size-data)',
      letterSpacing: '0.12em',
      textTransform: 'uppercase',
      color: 'var(--text-primary)'
    }
  }, day), relative && /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-log)',
      lineHeight: 1,
      color: 'var(--text-muted)'
    }
  }, relative)));
  if (!asRow) return /*#__PURE__*/React.createElement("div", _extends({
    style: style
  }, rest), inner);
  return /*#__PURE__*/React.createElement("tr", rest, /*#__PURE__*/React.createElement("td", {
    colSpan: colSpan,
    style: {
      padding: 0,
      ...style
    }
  }, inner));
}
Object.assign(__ds_scope, { DayHeader });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/DayHeader.jsx", error: String((e && e.message) || e) }); }

// components/data/QuorumMeter.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const fills = {
  in: 'var(--state-in)',
  maybe: 'var(--state-maybe)',
  out: 'var(--state-out)'
};
function QuorumMeter({
  inCount = 0,
  maybeCount = 0,
  outCount = 0,
  total = 0,
  quorum,
  showCount = true,
  size = 11,
  style,
  ...rest
}) {
  const pips = [];
  for (let i = 0; i < inCount; i++) pips.push('in');
  for (let i = 0; i < maybeCount; i++) pips.push('maybe');
  for (let i = 0; i < outCount; i++) pips.push('out');
  while (pips.length < total) pips.push('silent');
  const short = quorum != null && inCount < quorum;
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 1,
      ...style
    }
  }, rest), pips.map((k, i) => /*#__PURE__*/React.createElement("i", {
    key: i,
    style: {
      width: size,
      height: size,
      flex: 'none',
      background: fills[k] || 'var(--state-silent-bg)',
      border: '1px solid ' + (fills[k] || 'var(--line-structural)'),
      boxSizing: 'border-box'
    }
  })), showCount && /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 'var(--space-4)',
      font: 'var(--type-data)',
      color: short ? 'var(--state-maybe-text)' : 'var(--text-secondary)'
    }
  }, inCount, "/", total, short ? ' · needs ' + (quorum - inCount) : ''));
}
Object.assign(__ds_scope, { QuorumMeter });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/QuorumMeter.jsx", error: String((e && e.message) || e) }); }

// components/data/RosterRow.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const states = {
  in: {
    label: 'In',
    color: 'var(--state-in-text)'
  },
  out: {
    label: 'Out',
    color: 'var(--state-out-text)'
  },
  maybe: {
    label: 'Maybe',
    color: 'var(--state-maybe-text)'
  },
  silent: {
    label: '—',
    color: 'var(--text-muted)'
  }
};
function Avatar({
  initials,
  tone,
  size = 20,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("i", _extends({
    style: {
      width: size,
      height: size,
      flex: 'none',
      display: 'grid',
      placeItems: 'center',
      background: tone || 'var(--surface-raised)',
      border: '1px solid var(--line-structural)',
      font: 'var(--font-mono)',
      fontWeight: 500,
      fontSize: 'var(--size-micro)',
      fontStyle: 'normal',
      color: 'var(--text-secondary)',
      ...style
    }
  }, rest), initials);
}
function RosterRow({
  name,
  initials,
  role,
  intent = 'silent',
  attended,
  note,
  style,
  ...rest
}) {
  const s = states[intent] || states.silent;
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--space-4)',
      padding: 'var(--space-3) 0',
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement(Avatar, {
    initials: initials
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-small)'
    }
  }, name, role && /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text-muted)'
    }
  }, " (", role, ")")), note && /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-log)',
      lineHeight: 1,
      color: 'var(--text-muted)'
    }
  }, note), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 'auto',
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--space-4)'
    }
  }, attended != null && /*#__PURE__*/React.createElement("i", {
    style: {
      width: 10,
      height: 10,
      border: '1px solid ' + (attended ? 'var(--state-in)' : 'var(--line-strong)'),
      background: attended ? 'var(--state-in)' : 'transparent',
      fontStyle: 'normal'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-label)',
      fontWeight: 500,
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
      color: s.color
    }
  }, s.label)));
}
Object.assign(__ds_scope, { Avatar, RosterRow });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/RosterRow.jsx", error: String((e && e.message) || e) }); }

// components/data/SessionRow.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const toneFor = s => ({
  confirmed: 'in',
  jeopardy: 'maybe',
  open: 'accent',
  unposted: 'idle',
  cancelled: 'out',
  played: 'neutral'
})[s] || 'neutral';
const labelFor = s => ({
  confirmed: 'Confirmed',
  jeopardy: 'Quorum short',
  open: 'Poll open',
  unposted: 'Unposted',
  cancelled: 'Cancelled',
  played: 'Played'
})[s] || s;
function SessionRow({
  when,
  time,
  inlineTime = false,
  title,
  subtitle,
  attendance,
  state = 'confirmed',
  selected = false,
  onClick,
  style,
  ...rest
}) {
  const [hot, setHot] = React.useState(false);
  return /*#__PURE__*/React.createElement("tr", _extends({
    onClick: onClick,
    onMouseEnter: () => setHot(true),
    onMouseLeave: () => setHot(false),
    "aria-selected": selected,
    style: {
      borderBottom: '1px solid var(--line-hair)',
      cursor: 'pointer',
      background: selected || hot ? 'var(--surface-raised)' : 'transparent',
      boxShadow: selected ? 'var(--marker-selected)' : 'none',
      transition: 'var(--transition-hover)',
      ...style
    }
  }, rest), !inlineTime && /*#__PURE__*/React.createElement(__ds_scope.Cell, {
    style: {
      font: 'var(--type-data)',
      whiteSpace: 'nowrap'
    }
  }, when, time && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text-muted)',
      fontWeight: 400
    }
  }, time))), /*#__PURE__*/React.createElement(__ds_scope.Cell, null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 'var(--space-6)'
    }
  }, inlineTime && time && /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-data)',
      color: 'var(--text-muted)',
      flex: 'none'
    }
  }, time), /*#__PURE__*/React.createElement("div", {
    style: {
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-body-medium)'
    }
  }, title), subtitle && /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-log)',
      lineHeight: 1.4,
      color: 'var(--text-muted)',
      marginTop: 2
    }
  }, subtitle)))), /*#__PURE__*/React.createElement(__ds_scope.Cell, null, attendance ? /*#__PURE__*/React.createElement(__ds_scope.QuorumMeter, attendance) : null), /*#__PURE__*/React.createElement(__ds_scope.Cell, null, /*#__PURE__*/React.createElement(__ds_scope.Pill, {
    tone: toneFor(state),
    dot: state === 'open'
  }, labelFor(state))));
}
Object.assign(__ds_scope, { SessionRow });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/SessionRow.jsx", error: String((e && e.message) || e) }); }

// components/data/SyncLog.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function SyncLog({
  entries = [],
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      font: 'var(--type-log)',
      color: 'var(--text-muted)',
      ...style
    }
  }, rest), entries.map((e, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: 'flex',
      gap: 'var(--space-4)'
    }
  }, /*#__PURE__*/React.createElement("b", {
    style: {
      color: 'var(--text-secondary)',
      fontWeight: 400,
      flex: 'none'
    }
  }, e.at), /*#__PURE__*/React.createElement("span", {
    style: {
      color: e.tone === 'error' ? 'var(--state-out-text)' : e.tone === 'write' ? 'var(--text-secondary)' : 'inherit'
    }
  }, e.text))));
}
Object.assign(__ds_scope, { SyncLog });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/SyncLog.jsx", error: String((e && e.message) || e) }); }

// components/discord/DiscordButtonRow.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const styles = {
  primary: {
    background: 'var(--discord-blurple)',
    color: '#fff'
  },
  secondary: {
    background: 'var(--discord-grey-btn)',
    color: '#fff'
  },
  success: {
    background: 'var(--discord-green)',
    color: '#fff'
  },
  danger: {
    background: 'var(--discord-red)',
    color: '#fff'
  },
  link: {
    background: 'var(--discord-grey-btn)',
    color: '#fff'
  }
};
function DiscordButtonRow({
  buttons = [],
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: 'var(--space-4)',
      marginTop: 'var(--space-4)',
      maxWidth: 520,
      fontFamily: 'var(--font-discord)',
      ...style
    }
  }, rest), buttons.slice(0, 5).map((b, i) => /*#__PURE__*/React.createElement("button", {
    key: i,
    type: "button",
    disabled: b.disabled,
    onClick: b.onClick,
    style: {
      ...styles[b.style || 'secondary'],
      border: 0,
      borderRadius: 3,
      height: 32,
      padding: '0 16px',
      fontSize: 14,
      fontWeight: 500,
      fontFamily: 'inherit',
      cursor: b.disabled ? 'not-allowed' : 'pointer',
      opacity: b.disabled ? 0.5 : 1,
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6
    }
  }, b.emoji && /*#__PURE__*/React.createElement("span", null, b.emoji), b.label, b.count != null && /*#__PURE__*/React.createElement("span", {
    style: {
      opacity: .7
    }
  }, b.count))));
}
Object.assign(__ds_scope, { DiscordButtonRow });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/discord/DiscordButtonRow.jsx", error: String((e && e.message) || e) }); }

// components/discord/DiscordEmbed.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function DiscordEmbed({
  color = 'var(--campaign-1)',
  title,
  url,
  description,
  fields = [],
  asOf,
  footer,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      display: 'flex',
      maxWidth: 520,
      background: 'var(--discord-embed)',
      borderRadius: 'var(--radius-discord)',
      overflow: 'hidden',
      fontFamily: 'var(--font-discord)',
      marginTop: 'var(--space-3)',
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("i", {
    style: {
      width: 4,
      flex: 'none',
      background: color
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 'var(--space-6) var(--space-7) var(--space-7)',
      minWidth: 0,
      flex: 1
    }
  }, title && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 16,
      fontWeight: 600,
      color: url ? 'var(--discord-link)' : '#f2f3f5',
      marginBottom: 'var(--space-4)'
    }
  }, title), description && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      lineHeight: 1.45,
      color: 'var(--discord-text)',
      whiteSpace: 'pre-wrap'
    }
  }, description), fields.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(3,1fr)',
      gap: 'var(--space-4) var(--space-4)',
      marginTop: 'var(--space-6)'
    }
  }, fields.map((fd, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      gridColumn: fd.inline === false ? '1 / -1' : 'auto'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      fontWeight: 600,
      color: '#f2f3f5',
      marginBottom: 2
    }
  }, fd.name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      lineHeight: 1.4,
      color: 'var(--discord-text)',
      whiteSpace: 'pre-wrap'
    }
  }, fd.value)))), (asOf || footer) && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 'var(--space-4)',
      marginTop: 'var(--space-6)',
      fontSize: 12,
      color: 'var(--discord-muted)'
    }
  }, footer && /*#__PURE__*/React.createElement("span", null, footer), footer && asOf && /*#__PURE__*/React.createElement("span", null, "\xB7"), asOf && /*#__PURE__*/React.createElement("span", null, asOf))));
}
Object.assign(__ds_scope, { DiscordEmbed });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/discord/DiscordEmbed.jsx", error: String((e && e.message) || e) }); }

// components/discord/DiscordMessage.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function DiscordMessage({
  author = 'Orrey',
  bot = true,
  timestamp,
  avatarInitials = 'OR',
  children,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      display: 'flex',
      gap: 'var(--space-7)',
      padding: 'var(--space-4) var(--space-8)',
      background: 'var(--discord-bg)',
      fontFamily: 'var(--font-discord)',
      color: 'var(--discord-text)',
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("i", {
    style: {
      width: 40,
      height: 40,
      flex: 'none',
      borderRadius: 'var(--radius-circle)',
      background: 'var(--slate-950)',
      display: 'grid',
      placeItems: 'center',
      font: 'var(--font-ui)',
      fontWeight: 700,
      fontSize: 13,
      letterSpacing: '0.06em',
      fontStyle: 'normal',
      color: 'var(--signal-500)'
    }
  }, avatarInitials), /*#__PURE__*/React.createElement("div", {
    style: {
      minWidth: 0,
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--space-4)',
      marginBottom: 2
    }
  }, /*#__PURE__*/React.createElement("b", {
    style: {
      fontSize: 15,
      fontWeight: 600,
      color: '#f2f3f5'
    }
  }, author), bot && /*#__PURE__*/React.createElement("span", {
    style: {
      background: 'var(--discord-blurple)',
      color: '#fff',
      fontSize: 10,
      fontWeight: 600,
      padding: '1px 4px',
      borderRadius: 3,
      letterSpacing: '.02em'
    }
  }, "APP"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: 'var(--discord-muted)'
    }
  }, timestamp)), children));
}
Object.assign(__ds_scope, { DiscordMessage });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/discord/DiscordMessage.jsx", error: String((e && e.message) || e) }); }

// components/discord/DiscordSelect.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function DiscordSelect({
  placeholder = 'Select dates',
  options = [],
  open = false,
  selected = [],
  onToggle,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      maxWidth: 400,
      marginTop: 'var(--space-4)',
      fontFamily: 'var(--font-discord)',
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      height: 38,
      padding: '0 12px',
      background: 'var(--discord-bg-alt)',
      border: '1px solid rgba(0,0,0,.3)',
      borderRadius: 4,
      color: selected.length ? 'var(--discord-text)' : 'var(--discord-muted)',
      fontSize: 14,
      cursor: 'pointer'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap'
    }
  }, selected.length ? selected.join(', ') : placeholder), /*#__PURE__*/React.createElement("i", {
    style: {
      width: 0,
      height: 0,
      borderLeft: '4px solid transparent',
      borderRight: '4px solid transparent',
      borderTop: '5px solid var(--discord-muted)'
    }
  })), open && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 4,
      background: 'var(--discord-bg-alt)',
      borderRadius: 4,
      boxShadow: 'var(--shadow-discord)',
      padding: '6px 0',
      maxHeight: 220,
      overflow: 'auto'
    }
  }, options.map((o, i) => {
    const v = typeof o === 'string' ? o : o.label;
    const on = selected.includes(v);
    return /*#__PURE__*/React.createElement("div", {
      key: i,
      onClick: () => onToggle && onToggle(v),
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '7px 12px',
        cursor: 'pointer',
        background: on ? 'rgba(88,101,242,.15)' : 'transparent',
        fontSize: 14
      }
    }, /*#__PURE__*/React.createElement("i", {
      style: {
        width: 14,
        height: 14,
        flex: 'none',
        borderRadius: 3,
        border: '1px solid ' + (on ? 'var(--discord-blurple)' : 'var(--discord-muted)'),
        background: on ? 'var(--discord-blurple)' : 'transparent'
      }
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1,
        color: 'var(--discord-text)'
      }
    }, v), typeof o === 'object' && o.count != null && /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 12,
        color: 'var(--discord-muted)'
      }
    }, o.count));
  })));
}
Object.assign(__ds_scope, { DiscordSelect });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/discord/DiscordSelect.jsx", error: String((e && e.message) || e) }); }

// components/discord/EphemeralNote.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function EphemeralNote({
  children,
  dismissable = true,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      maxWidth: 520,
      marginTop: 'var(--space-4)',
      fontFamily: 'var(--font-discord)',
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("div", null, children), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      marginTop: 'var(--space-4)',
      fontSize: 12,
      color: 'var(--discord-muted)'
    }
  }, /*#__PURE__*/React.createElement("i", {
    style: {
      width: 12,
      height: 12,
      borderRadius: 'var(--radius-circle)',
      border: '1px solid var(--discord-muted)',
      display: 'grid',
      placeItems: 'center',
      fontSize: 8,
      fontStyle: 'normal',
      lineHeight: 1
    }
  }, "i"), /*#__PURE__*/React.createElement("span", null, "Only you can see this", dismissable && /*#__PURE__*/React.createElement(React.Fragment, null, " \xB7 ", /*#__PURE__*/React.createElement("a", {
    href: "#",
    style: {
      color: 'var(--discord-link)'
    }
  }, "Dismiss message")))));
}
Object.assign(__ds_scope, { EphemeralNote });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/discord/EphemeralNote.jsx", error: String((e && e.message) || e) }); }

// components/nav/SegmentedFilter.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function SegmentedFilter({
  options = [],
  value,
  onChange,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      display: 'inline-flex',
      border: '1px solid var(--line-structural)',
      ...style
    }
  }, rest), options.map((o, i) => {
    const v = typeof o === 'string' ? o : o.value,
      l = typeof o === 'string' ? o : o.label;
    const on = v === value;
    return /*#__PURE__*/React.createElement("button", {
      key: v,
      type: "button",
      "aria-pressed": on,
      onClick: () => onChange && onChange(v),
      style: {
        background: on ? 'var(--action-bg)' : 'transparent',
        color: on ? 'var(--action-ink)' : 'var(--text-secondary)',
        border: 0,
        borderRight: i < options.length - 1 ? '1px solid var(--line-structural)' : 0,
        font: 'var(--type-label)',
        fontWeight: 500,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        padding: '7px 11px',
        cursor: 'pointer',
        transition: 'var(--transition-hover)'
      }
    }, l);
  }));
}
Object.assign(__ds_scope, { SegmentedFilter });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/nav/SegmentedFilter.jsx", error: String((e && e.message) || e) }); }

// components/nav/Sidebar.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function Sidebar({
  children,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("nav", _extends({
    style: {
      width: 'var(--chrome-sidebar)',
      flex: 'none',
      overflow: 'auto',
      background: 'var(--surface-chrome)',
      borderRight: '1px solid var(--line-structural)',
      ...style
    }
  }, rest), children);
}
function SidebarSection({
  label,
  count,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      display: 'flex',
      gap: 'var(--space-3)',
      font: 'var(--type-micro)',
      letterSpacing: 'var(--tracking-label)',
      textTransform: 'uppercase',
      color: 'var(--text-muted)',
      padding: 'var(--space-7) var(--space-7) var(--space-4)',
      borderBottom: '1px solid var(--line-hair)',
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("span", null, label), count != null && /*#__PURE__*/React.createElement("span", null, "\xB7 ", count));
}
function NavItem({
  color,
  label,
  meta,
  active = false,
  onClick,
  style,
  ...rest
}) {
  const [hot, setHot] = React.useState(false);
  return /*#__PURE__*/React.createElement("div", _extends({
    onClick: onClick,
    onMouseEnter: () => setHot(true),
    onMouseLeave: () => setHot(false),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--space-4)',
      padding: 'var(--space-4) var(--space-7)',
      cursor: 'pointer',
      borderBottom: '1px solid var(--line-hair)',
      background: active || hot ? 'var(--surface-raised)' : 'transparent',
      boxShadow: active ? 'var(--marker-selected)' : 'none',
      transition: 'var(--transition-hover)',
      ...style
    }
  }, rest), color && /*#__PURE__*/React.createElement("i", {
    style: {
      width: 7,
      height: 7,
      flex: 'none',
      background: color
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      font: 'var(--type-body-medium)',
      fontSize: 'var(--size-small)'
    }
  }, label), meta != null && /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-log)',
      lineHeight: 1,
      color: 'var(--text-muted)'
    }
  }, meta));
}
Object.assign(__ds_scope, { Sidebar, SidebarSection, NavItem });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/nav/Sidebar.jsx", error: String((e && e.message) || e) }); }

// components/nav/StatusBar.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function StatusBar({
  children,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("footer", _extends({
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--space-8)',
      height: 'var(--chrome-statusbar)',
      padding: '0 var(--space-7)',
      background: 'var(--surface-chrome)',
      borderTop: '1px solid var(--line-structural)',
      font: 'var(--type-log)',
      lineHeight: 1,
      letterSpacing: 'var(--tracking-data)',
      color: 'var(--text-muted)',
      ...style
    }
  }, rest), children);
}
function StatusItem({
  label,
  value,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("span", _extends({
    style: {
      display: 'inline-flex',
      gap: 'var(--space-3)',
      ...style
    }
  }, rest), label, value != null && /*#__PURE__*/React.createElement("b", {
    style: {
      color: 'var(--text-secondary)',
      fontWeight: 400
    }
  }, value));
}
Object.assign(__ds_scope, { StatusBar, StatusItem });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/nav/StatusBar.jsx", error: String((e && e.message) || e) }); }

// components/nav/SyncChip.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const colors = {
  ok: 'var(--state-in)',
  stale: 'var(--state-maybe)',
  down: 'var(--state-out)',
  off: 'var(--text-muted)'
};
function SyncChip({
  status = 'ok',
  label,
  children,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--space-3)',
      height: 'var(--chrome-topbar)',
      padding: '0 var(--space-6)',
      borderLeft: '1px solid var(--line-structural)',
      font: 'var(--type-log)',
      fontSize: 'var(--size-label)',
      lineHeight: 1,
      letterSpacing: 'var(--tracking-data)',
      textTransform: 'uppercase',
      color: 'var(--text-secondary)',
      ...style
    }
  }, rest), status && /*#__PURE__*/React.createElement("i", {
    style: {
      width: 5,
      height: 5,
      background: colors[status],
      flex: 'none'
    }
  }), label || children);
}
Object.assign(__ds_scope, { SyncChip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/nav/SyncChip.jsx", error: String((e && e.message) || e) }); }

// components/nav/TopBar.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function TopBar({
  children,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("header", _extends({
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--space-7)',
      height: 'var(--chrome-topbar)',
      padding: '0 var(--space-7)',
      background: 'var(--surface-chrome)',
      borderBottom: '1px solid var(--line-structural)',
      ...style
    }
  }, rest), children);
}
function Wordmark({
  size = 13,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("span", _extends({
    style: {
      font: 'var(--font-ui)',
      fontWeight: 700,
      fontSize: size,
      lineHeight: 1,
      letterSpacing: 'var(--tracking-wordmark)',
      textTransform: 'uppercase',
      color: 'var(--text-primary)',
      whiteSpace: 'nowrap',
      ...style
    }
  }, rest), "Orrey", /*#__PURE__*/React.createElement("b", {
    style: {
      color: 'var(--signal-500)'
    }
  }, "\xB7"), "of Worlds");
}
Object.assign(__ds_scope, { TopBar, Wordmark });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/nav/TopBar.jsx", error: String((e && e.message) || e) }); }

// ui_kits/console/Agenda.jsx
try { (() => {
const {
  DataTable,
  DayHeader,
  SessionRow,
  SegmentedFilter,
  Button
} = window.OrreyDesignSystem_4c8cbd;
const COLS_FLAT = [{
  label: 'When',
  width: 86
}, {
  label: 'Session'
}, {
  label: 'Responses',
  width: 170
}, {
  label: 'Status',
  width: 118
}];
const COLS_GROUPED = [{
  label: 'Session'
}, {
  label: 'Responses',
  width: 170
}, {
  label: 'Status',
  width: 118
}];
const UNSETTLED = ['jeopardy', 'open', 'unposted'];
const DAYNAME = {
  Mon: 'Monday',
  Tue: 'Tuesday',
  Wed: 'Wednesday',
  Thu: 'Thursday',
  Fri: 'Friday',
  Sat: 'Saturday',
  Sun: 'Sunday'
};
const VIEWS = {
  scheduling: {
    title: "What I'm scheduling",
    lede: "Sessions still waiting on something — an answer, a poll, or a post. Orrey holds a poll for fourteen days; after that the date is yours to move.",
    filters: ['All', 'Quorum short', 'Poll open', 'Unposted'],
    match: a => UNSETTLED.includes(a.state),
    sub: {
      'Quorum short': a => a.state === 'jeopardy',
      'Poll open': a => a.state === 'open',
      'Unposted': a => a.state === 'unposted'
    }
  },
  confirmed: {
    title: "What's confirmed",
    lede: "Quorum met, Discord posted, calendar written. Nothing here needs you — it is the record, not the work.",
    filters: ['All', 'Campaign sessions', 'Game days'],
    match: a => !UNSETTLED.includes(a.state),
    sub: {
      'Campaign sessions': a => a.kind === 'campaign_session',
      'Game days': a => a.kind === 'game_day'
    }
  }
};
function unsettledIds() {
  return window.ORREY.agenda.filter(a => UNSETTLED.includes(a.state)).map(a => a.id);
}
function settledIds() {
  return window.ORREY.agenda.filter(a => !UNSETTLED.includes(a.state)).map(a => a.id);
}
function tally(roster = []) {
  const c = k => roster.filter(r => r[1] === k).length;
  return {
    inCount: c('in'),
    maybeCount: c('maybe'),
    outCount: c('out'),
    total: roster.length
  };
}
function Agenda({
  mode = 'scheduling',
  grouped,
  setGrouped,
  filter,
  setFilter,
  selected,
  onSelect
}) {
  const v = VIEWS[mode];
  const f = v.filters.includes(filter) ? filter : 'All';
  const items = window.ORREY.agenda.filter(v.match).filter(a => f === 'All' ? true : v.sub[f](a));
  const rows = [];
  let lastDay = null;
  items.forEach(a => {
    const q = window.ORREY.campaigns.find(c => c.id === a.campaign);
    if (grouped && a.day !== lastDay) {
      const parts = a.day.split(' ');
      rows.push(/*#__PURE__*/React.createElement(DayHeader, {
        key: 'd' + a.id,
        lead: parts[1],
        gutter: 62,
        day: (DAYNAME[parts[0]] || parts[0]) + ', ' + parts[2],
        relative: a.rel,
        colSpan: grouped ? 3 : 4
      }));
      lastDay = a.day;
    }
    rows.push(/*#__PURE__*/React.createElement(SessionRow, {
      key: a.id,
      inlineTime: grouped,
      when: a.when,
      time: a.time,
      title: a.title,
      subtitle: a.sub,
      state: a.state,
      attendance: {
        ...tally(a.roster),
        quorum: q ? q.quorum : 6
      },
      selected: selected === a.id,
      onClick: () => onSelect(a.id)
    }));
  });
  return /*#__PURE__*/React.createElement("main", {
    style: {
      overflow: 'auto',
      minWidth: 560,
      padding: 'var(--space-8) var(--chrome-gutter) var(--space-10)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 'var(--space-6)'
    }
  }, /*#__PURE__*/React.createElement("h1", {
    style: {
      font: 'var(--type-title)',
      margin: 0
    }
  }, v.title), /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-log)',
      lineHeight: 1,
      letterSpacing: 'var(--tracking-data)',
      textTransform: 'uppercase',
      color: mode === 'scheduling' ? 'var(--state-maybe-text)' : 'var(--text-muted)'
    }
  }, items.length, " ", mode === 'scheduling' ? 'open' : 'settled')), /*#__PURE__*/React.createElement("p", {
    style: {
      font: 'var(--type-small)',
      color: 'var(--text-secondary)',
      maxWidth: '62ch',
      margin: 'var(--space-5) 0 0'
    }
  }, v.lede), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 'var(--space-3)',
      alignItems: 'center',
      margin: 'var(--space-7) 0 var(--space-5)'
    }
  }, /*#__PURE__*/React.createElement(SegmentedFilter, {
    options: v.filters,
    value: f,
    onChange: setFilter
  }), /*#__PURE__*/React.createElement(SegmentedFilter, {
    options: [{
      value: 'grouped',
      label: 'By day'
    }, {
      value: 'flat',
      label: 'Flat'
    }],
    value: grouped ? 'grouped' : 'flat',
    onChange: x => setGrouped(x === 'grouped')
  }), mode === 'scheduling' && /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    style: {
      marginLeft: 'auto'
    }
  }, "+ Session")), /*#__PURE__*/React.createElement(DataTable, {
    columns: grouped ? COLS_GROUPED : COLS_FLAT
  }, rows), items.length === 0 && /*#__PURE__*/React.createElement("p", {
    style: {
      font: 'var(--type-small)',
      color: 'var(--text-muted)',
      padding: 'var(--space-9) 0'
    }
  }, mode === 'scheduling' ? 'Nothing outstanding. Every session in the horizon has an answer.' : 'Nothing confirmed in this slice yet.'));
}
Object.assign(window, {
  Agenda,
  tally,
  unsettledIds,
  settledIds
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/console/Agenda.jsx", error: String((e && e.message) || e) }); }

// ui_kits/console/CampaignPage.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const {
  Panel,
  Button,
  Pill,
  Field,
  Input,
  Select,
  Checkbox,
  DataTable,
  Cell,
  RosterRow,
  Tag,
  QuorumMeter
} = window.OrreyDesignSystem_4c8cbd;
function CampaignPage({
  campaign
}) {
  const c = campaign;
  const sessions = window.ORREY.agenda.filter(a => a.campaign === c.id);
  const [auto, setAuto] = React.useState(c.id === 'umbra');
  const stateTone = {
    RUNNING: 'in',
    FORMING: 'accent',
    HIATUS: 'maybe',
    CONCLUDED: 'idle'
  }[c.state];
  return /*#__PURE__*/React.createElement("main", {
    style: {
      overflow: 'auto',
      padding: 'var(--space-8) var(--chrome-gutter) var(--space-10)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--space-6)'
    }
  }, /*#__PURE__*/React.createElement("i", {
    style: {
      width: 10,
      height: 10,
      background: c.color
    }
  }), /*#__PURE__*/React.createElement("h1", {
    style: {
      font: 'var(--type-title)',
      margin: 0
    }
  }, c.name), /*#__PURE__*/React.createElement(Pill, {
    tone: stateTone
  }, c.state), /*#__PURE__*/React.createElement(Tag, null, c.channel), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    style: {
      marginLeft: 'auto'
    }
  }, "Post next session")), /*#__PURE__*/React.createElement("p", {
    style: {
      font: 'var(--type-small)',
      color: 'var(--text-secondary)',
      maxWidth: '62ch',
      marginTop: 'var(--space-5)'
    }
  }, c.state === 'FORMING' ? 'Signup buttons are live. A closed roster never reopens on its own — reopen it here if someone drops before session one.' : 'Signups are closed. Attendance posts go out on the cadence below; the roster is fixed until you change it.'), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 'var(--space-8)',
      marginTop: 'var(--space-8)'
    }
  }, /*#__PURE__*/React.createElement(Panel, {
    title: "Cadence"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gap: 'var(--space-6)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 'var(--space-6)'
    }
  }, /*#__PURE__*/React.createElement(Field, {
    label: "Anchor date",
    hint: "May sit in the past."
  }, /*#__PURE__*/React.createElement(Input, {
    defaultValue: "2025-02-06"
  })), /*#__PURE__*/React.createElement(Field, {
    label: "Interval (weeks)"
  }, /*#__PURE__*/React.createElement(Input, {
    defaultValue: c.id === 'umbra' ? '1' : '2'
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 'var(--space-6)'
    }
  }, /*#__PURE__*/React.createElement(Field, {
    label: "Quorum",
    hint: "Minimum for it to run."
  }, /*#__PURE__*/React.createElement(Input, {
    defaultValue: String(c.quorum)
  })), /*#__PURE__*/React.createElement(Field, {
    label: "Location"
  }, /*#__PURE__*/React.createElement(Select, {
    options: ['External venue', 'Voice channel']
  }))), /*#__PURE__*/React.createElement(Field, {
    label: "First session number",
    hint: "History starts empty; seed the count."
  }, /*#__PURE__*/React.createElement(Input, {
    defaultValue: String(c.sessions + 1)
  })), /*#__PURE__*/React.createElement(Checkbox, {
    checked: auto,
    onChange: setAuto,
    label: "Auto-resolve this campaign's date polls"
  }), /*#__PURE__*/React.createElement("p", {
    style: {
      font: 'var(--type-small)',
      color: 'var(--text-muted)',
      margin: 0
    }
  }, "Never onto a date the GM has not marked available."))), /*#__PURE__*/React.createElement(Panel, {
    title: "Roster",
    meta: c.roster + ' of ' + c.roster,
    actions: /*#__PURE__*/React.createElement(Button, {
      size: "sm"
    }, "Add")
  }, window.ORREY.people.filter(p => p.on.includes(c.id)).map(p => /*#__PURE__*/React.createElement(RosterRow, {
    key: p.id,
    name: p.name,
    initials: p.initials,
    role: p.name === c.gm ? 'GM' : undefined,
    intent: p.dm === 'closed' ? 'maybe' : 'in',
    note: p.dm === 'closed' ? 'dms closed' : undefined
  })), /*#__PURE__*/React.createElement("p", {
    style: {
      font: 'var(--type-small)',
      color: 'var(--text-muted)',
      margin: 'var(--space-6) 0 0'
    }
  }, "A player with DMs closed is reminded by channel mention instead. Orrey learns this from error 50007 and does not retry."))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 'var(--space-8)'
    }
  }, /*#__PURE__*/React.createElement(Panel, {
    title: "Sessions",
    meta: sessions.length + ' in horizon',
    flush: true
  }, /*#__PURE__*/React.createElement(DataTable, {
    columns: [{
      label: 'When',
      width: 110
    }, {
      label: 'Session'
    }, {
      label: 'Venue',
      width: 200
    }, {
      label: 'State',
      width: 120
    }]
  }, sessions.map(s => {
    const t = window.tally(s.roster);
    return /*#__PURE__*/React.createElement("tr", {
      key: s.id,
      style: {
        borderBottom: '1px solid var(--line-hair)'
      }
    }, /*#__PURE__*/React.createElement(Cell, {
      style: {
        font: 'var(--type-data)'
      }
    }, s.when, " \xB7 ", s.time), /*#__PURE__*/React.createElement(Cell, null, /*#__PURE__*/React.createElement("span", {
      style: {
        font: 'var(--type-body-medium)'
      }
    }, s.title), /*#__PURE__*/React.createElement("div", {
      style: {
        font: 'var(--type-log)',
        lineHeight: 1.4,
        color: 'var(--text-muted)'
      }
    }, s.sub)), /*#__PURE__*/React.createElement(Cell, {
      style: {
        font: 'var(--type-log)',
        color: 'var(--text-secondary)'
      }
    }, s.venue), /*#__PURE__*/React.createElement(Cell, null, /*#__PURE__*/React.createElement(QuorumMeter, _extends({}, t, {
      quorum: c.quorum,
      size: 9
    }))));
  })))));
}
Object.assign(window, {
  CampaignPage
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/console/CampaignPage.jsx", error: String((e && e.message) || e) }); }

// ui_kits/console/ConsoleApp.jsx
try { (() => {
const {
  TopBar,
  Wordmark,
  Tag,
  SyncChip,
  Sidebar,
  SidebarSection,
  NavItem,
  StatusBar,
  StatusItem
} = window.OrreyDesignSystem_4c8cbd;
function ConsoleApp() {
  const [view, setView] = React.useState({
    kind: 'agenda',
    mode: 'scheduling'
  });
  const [grouped, setGrouped] = React.useState(true);
  const [filter, setFilter] = React.useState('All');
  const [sel, setSel] = React.useState(window.unsettledIds()[0]);
  const goAgenda = mode => {
    setView({
      kind: 'agenda',
      mode
    });
    setFilter('All');
    setSel((mode === 'scheduling' ? window.unsettledIds() : window.settledIds())[0]);
  };
  const item = window.ORREY.agenda.find(a => a.id === sel);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateRows: 'auto 1fr auto',
      height: '100vh',
      minHeight: 0
    }
  }, /*#__PURE__*/React.createElement(TopBar, null, /*#__PURE__*/React.createElement(Wordmark, null), /*#__PURE__*/React.createElement(Tag, null, "CONSOLE"), /*#__PURE__*/React.createElement("div", {
    style: {
      marginLeft: 'auto',
      display: 'flex'
    }
  }, /*#__PURE__*/React.createElement(SyncChip, {
    status: "ok",
    label: "Discord ok"
  }), /*#__PURE__*/React.createElement(SyncChip, {
    status: "stale",
    label: "GCal 4m ago"
  }), /*#__PURE__*/React.createElement(SyncChip, {
    status: "off",
    label: "Rowan"
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      minHeight: 0
    }
  }, /*#__PURE__*/React.createElement(Sidebar, null, /*#__PURE__*/React.createElement(SidebarSection, {
    label: "Schedule"
  }), /*#__PURE__*/React.createElement(NavItem, {
    label: "What I'm scheduling",
    meta: window.unsettledIds().length,
    active: view.kind === 'agenda' && view.mode === 'scheduling',
    onClick: () => goAgenda('scheduling')
  }), /*#__PURE__*/React.createElement(NavItem, {
    label: "What's confirmed",
    meta: window.settledIds().length,
    active: view.kind === 'agenda' && view.mode === 'confirmed',
    onClick: () => goAgenda('confirmed')
  }), /*#__PURE__*/React.createElement(NavItem, {
    label: "Date polls",
    meta: 1,
    active: view.kind === 'poll',
    onClick: () => setView({
      kind: 'poll'
    })
  }), /*#__PURE__*/React.createElement(SidebarSection, {
    label: "Campaigns",
    count: window.ORREY.campaigns.length
  }), window.ORREY.campaigns.map(c => /*#__PURE__*/React.createElement(NavItem, {
    key: c.id,
    color: c.color,
    label: c.name,
    meta: c.next,
    active: view.kind === 'campaign' && view.id === c.id,
    onClick: () => setView({
      kind: 'campaign',
      id: c.id
    })
  })), /*#__PURE__*/React.createElement(SidebarSection, {
    label: "Manage"
  }), /*#__PURE__*/React.createElement(NavItem, {
    label: "Players",
    meta: window.ORREY.people.length,
    active: view.kind === 'players',
    onClick: () => setView({
      kind: 'players'
    })
  }), /*#__PURE__*/React.createElement(NavItem, {
    label: "Games",
    meta: 9
  }), /*#__PURE__*/React.createElement(NavItem, {
    label: "Jobs",
    meta: 3
  }), /*#__PURE__*/React.createElement(NavItem, {
    label: "Settings"
  })), view.kind === 'agenda' && /*#__PURE__*/React.createElement(Agenda, {
    mode: view.mode,
    grouped: grouped,
    setGrouped: setGrouped,
    filter: filter,
    setFilter: setFilter,
    selected: sel,
    onSelect: setSel
  }), view.kind === 'campaign' && /*#__PURE__*/React.createElement(CampaignPage, {
    campaign: window.ORREY.campaigns.find(c => c.id === view.id)
  }), view.kind === 'players' && /*#__PURE__*/React.createElement(PlayersPage, null), view.kind === 'poll' && /*#__PURE__*/React.createElement(PollPage, null), view.kind === 'agenda' && /*#__PURE__*/React.createElement(DetailRail, {
    item: item
  })), /*#__PURE__*/React.createElement(StatusBar, null, /*#__PURE__*/React.createElement(StatusItem, {
    label: "DB",
    value: "authoritative"
  }), /*#__PURE__*/React.createElement(StatusItem, {
    label: "Open polls",
    value: 1
  }), /*#__PURE__*/React.createElement(StatusItem, {
    label: "Jobs pending",
    value: 3
  }), /*#__PURE__*/React.createElement(StatusItem, {
    label: "Next drain",
    value: "00:15"
  }), /*#__PURE__*/React.createElement(StatusItem, {
    label: "Horizon",
    value: "2 per campaign"
  })));
}
ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(ConsoleApp, null));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/console/ConsoleApp.jsx", error: String((e && e.message) || e) }); }

// ui_kits/console/DetailRail.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const {
  Panel,
  Button,
  Pill,
  RosterRow,
  SyncLog,
  QuorumMeter,
  Tag
} = window.OrreyDesignSystem_4c8cbd;
function DetailRail({
  item
}) {
  if (!item) return /*#__PURE__*/React.createElement("aside", {
    style: {
      width: 'var(--chrome-rail)',
      flex: 'none',
      borderLeft: '1px solid var(--line-structural)',
      background: 'var(--surface-chrome)',
      display: 'grid',
      placeItems: 'center',
      padding: 'var(--space-8)'
    }
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      font: 'var(--type-small)',
      color: 'var(--text-muted)',
      textAlign: 'center',
      margin: 0
    }
  }, "Select a session to see who has answered."));
  const c = window.ORREY.campaigns.find(x => x.id === item.campaign);
  const t = window.tally(item.roster);
  const short = c && t.inCount < c.quorum;
  return /*#__PURE__*/React.createElement("aside", {
    style: {
      width: 'var(--chrome-rail)',
      flex: 'none',
      overflow: 'auto',
      borderLeft: '1px solid var(--line-structural)',
      background: 'var(--surface-chrome)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 'var(--space-7)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-micro)',
      letterSpacing: 'var(--tracking-label)',
      textTransform: 'uppercase',
      color: 'var(--text-muted)'
    }
  }, item.day, " \xB7 ", item.time), /*#__PURE__*/React.createElement("h2", {
    style: {
      font: 'var(--type-heading)',
      margin: 'var(--space-4) 0 var(--space-2)'
    }
  }, item.title), /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-log)',
      lineHeight: 1.5,
      color: 'var(--text-secondary)',
      textTransform: 'uppercase',
      letterSpacing: 'var(--tracking-data)'
    }
  }, item.venue, c ? ' · GM ' + c.gm : ''), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 'var(--space-3)',
      marginTop: 'var(--space-6)',
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement(Tag, null, item.kind), c && /*#__PURE__*/React.createElement(Tag, null, `quorum ${c.quorum}`)), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 'var(--space-7)'
    }
  }, /*#__PURE__*/React.createElement(QuorumMeter, _extends({}, t, {
    quorum: c ? c.quorum : 6,
    size: 13
  }))), short && /*#__PURE__*/React.createElement("p", {
    style: {
      font: 'var(--type-small)',
      color: 'var(--state-maybe-text)',
      margin: 'var(--space-5) 0 0'
    }
  }, "Short of quorum. The answer to that is a date poll, not a cancellation.")), /*#__PURE__*/React.createElement("div", {
    style: {
      borderTop: '1px solid var(--line-structural)',
      padding: 'var(--space-6) var(--space-7)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-micro)',
      letterSpacing: 'var(--tracking-label)',
      textTransform: 'uppercase',
      color: 'var(--text-muted)',
      marginBottom: 'var(--space-4)'
    }
  }, "Roster ", t.inCount, "/", t.total), item.roster.map(([pid, intent, role, note]) => {
    const p = window.ORREY.people.find(x => x.id === pid) || {
      name: pid,
      initials: '??'
    };
    return /*#__PURE__*/React.createElement(RosterRow, {
      key: pid,
      name: p.name,
      initials: p.initials,
      role: role,
      intent: intent,
      note: note
    });
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      borderTop: '1px solid var(--line-structural)',
      padding: 'var(--space-6) var(--space-7)',
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 'var(--space-2)'
    }
  }, /*#__PURE__*/React.createElement(Button, {
    size: "sm",
    full: true
  }, "Nudge ", item.roster.filter(r => r[1] === 'silent').length), /*#__PURE__*/React.createElement(Button, {
    size: "sm",
    full: true
  }, "Reschedule"), /*#__PURE__*/React.createElement(Button, {
    size: "sm",
    full: true
  }, "Repost"), /*#__PURE__*/React.createElement(Button, {
    size: "sm",
    full: true,
    variant: "danger"
  }, "Cancel")), /*#__PURE__*/React.createElement("div", {
    style: {
      borderTop: '1px solid var(--line-structural)',
      padding: 'var(--space-6) var(--space-7)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-micro)',
      letterSpacing: 'var(--tracking-label)',
      textTransform: 'uppercase',
      color: 'var(--text-muted)',
      marginBottom: 'var(--space-4)'
    }
  }, "Sync log"), /*#__PURE__*/React.createElement(SyncLog, {
    entries: window.ORREY.log
  })));
}
Object.assign(window, {
  DetailRail
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/console/DetailRail.jsx", error: String((e && e.message) || e) }); }

// ui_kits/console/PlayersPage.jsx
try { (() => {
const {
  Panel,
  DataTable,
  Cell,
  Button,
  Pill,
  Tag,
  Avatar
} = window.OrreyDesignSystem_4c8cbd;
function PlayersPage() {
  const dmTone = {
    open: 'in',
    closed: 'out',
    unknown: 'idle'
  };
  return /*#__PURE__*/React.createElement("main", {
    style: {
      overflow: 'auto',
      padding: 'var(--space-8) var(--chrome-gutter) var(--space-10)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--space-6)'
    }
  }, /*#__PURE__*/React.createElement("h1", {
    style: {
      font: 'var(--type-title)',
      margin: 0
    }
  }, "Players"), /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-log)',
      lineHeight: 1,
      letterSpacing: 'var(--tracking-data)',
      textTransform: 'uppercase',
      color: 'var(--text-muted)'
    }
  }, window.ORREY.people.length, " known"), /*#__PURE__*/React.createElement(Button, {
    style: {
      marginLeft: 'auto'
    }
  }, "Export ICS tokens")), /*#__PURE__*/React.createElement("p", {
    style: {
      font: 'var(--type-small)',
      color: 'var(--text-secondary)',
      maxWidth: '64ch',
      marginTop: 'var(--space-5)'
    }
  }, "Discord id is the primary key; names are a cache. Flake memory is descriptive, not a score \u2014 it exists so the organiser can read a silent roster, not to rank anyone."), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 'var(--space-8)'
    }
  }, /*#__PURE__*/React.createElement(Panel, {
    title: "Roster",
    flush: true
  }, /*#__PURE__*/React.createElement(DataTable, {
    columns: [{
      label: 'Player',
      width: 200
    }, {
      label: 'On',
      width: 220
    }, {
      label: 'DMs',
      width: 110
    }, {
      label: 'Missed, last 10',
      width: 140
    }, {
      label: 'Feed',
      width: 110
    }]
  }, window.ORREY.people.map(p => /*#__PURE__*/React.createElement("tr", {
    key: p.id,
    style: {
      borderBottom: '1px solid var(--line-hair)'
    }
  }, /*#__PURE__*/React.createElement(Cell, null, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--space-5)'
    }
  }, /*#__PURE__*/React.createElement(Avatar, {
    initials: p.initials
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-body-medium)'
    }
  }, p.name))), /*#__PURE__*/React.createElement(Cell, null, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      gap: 4
    }
  }, p.on.map(id => {
    const c = window.ORREY.campaigns.find(x => x.id === id);
    return /*#__PURE__*/React.createElement("i", {
      key: id,
      title: c.name,
      style: {
        width: 7,
        height: 7,
        background: c.color
      }
    });
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-log)',
      lineHeight: 1,
      color: 'var(--text-muted)',
      marginLeft: 6
    }
  }, p.on.map(id => window.ORREY.campaigns.find(x => x.id === id).name).join(', ').toLowerCase()))), /*#__PURE__*/React.createElement(Cell, null, /*#__PURE__*/React.createElement(Pill, {
    tone: dmTone[p.dm]
  }, p.dm)), /*#__PURE__*/React.createElement(Cell, null, /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-data)',
      color: p.flake > 0.2 ? 'var(--state-maybe-text)' : 'var(--text-secondary)'
    }
  }, Math.round(p.flake * 10), " of 10")), /*#__PURE__*/React.createElement(Cell, null, /*#__PURE__*/React.createElement(Tag, null, "ics"))))))));
}
Object.assign(window, {
  PlayersPage
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/console/PlayersPage.jsx", error: String((e && e.message) || e) }); }

// ui_kits/console/PollPage.jsx
try { (() => {
const {
  Panel,
  Button,
  Pill,
  Select,
  Field,
  Checkbox,
  Tag,
  DataTable,
  Cell
} = window.OrreyDesignSystem_4c8cbd;
function PollPage() {
  const p = window.ORREY.poll;
  const [picked, setPicked] = React.useState(p.dates.filter(d => d.winning).map(d => d.date));
  const toggle = d => setPicked(s => s.includes(d) ? s.filter(x => x !== d) : [...s, d]);
  const max = Math.max(...p.dates.map(d => d.count));
  return /*#__PURE__*/React.createElement("main", {
    style: {
      overflow: 'auto',
      padding: 'var(--space-8) var(--chrome-gutter) var(--space-10)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--space-6)'
    }
  }, /*#__PURE__*/React.createElement("h1", {
    style: {
      font: 'var(--type-title)',
      margin: 0
    }
  }, "Date poll \xB7 no target"), /*#__PURE__*/React.createElement(Pill, {
    tone: "accent",
    dot: true
  }, "Open"), /*#__PURE__*/React.createElement(Tag, null, "closes ", p.closes)), /*#__PURE__*/React.createElement("p", {
    style: {
      font: 'var(--type-small)',
      color: 'var(--text-secondary)',
      maxWidth: '64ch',
      marginTop: 'var(--space-5)'
    }
  }, "One mechanism, two uses. With no target, winning dates are minted as game days \u2014 one poll may produce several. With a target, the poll moves that session instead. Winning is contextual and yours to call."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 300px',
      gap: 'var(--space-8)',
      marginTop: 'var(--space-8)',
      alignItems: 'start'
    }
  }, /*#__PURE__*/React.createElement(Panel, {
    title: "Candidate dates",
    meta: p.dates.length + ' of 10',
    flush: true
  }, /*#__PURE__*/React.createElement("div", null, p.dates.map(d => {
    const on = picked.includes(d.date);
    return /*#__PURE__*/React.createElement("div", {
      key: d.date,
      onClick: () => toggle(d.date),
      style: {
        display: 'grid',
        gridTemplateColumns: '18px 150px 1fr 64px',
        gap: 'var(--space-6)',
        alignItems: 'center',
        padding: 'var(--space-5) var(--space-7)',
        cursor: 'pointer',
        borderBottom: '1px solid var(--line-hair)',
        boxShadow: on ? 'var(--marker-selected)' : 'none',
        background: on ? 'var(--surface-raised)' : 'transparent'
      }
    }, /*#__PURE__*/React.createElement("i", {
      style: {
        width: 14,
        height: 14,
        border: '1px solid ' + (on ? 'var(--signal-500)' : 'var(--line-strong)'),
        background: on ? 'var(--signal-500)' : 'transparent'
      }
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        font: 'var(--type-body-medium)'
      }
    }, d.date), /*#__PURE__*/React.createElement("span", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-4)'
      }
    }, /*#__PURE__*/React.createElement("i", {
      style: {
        height: 8,
        width: d.count / max * 100 + '%',
        maxWidth: 200,
        background: d.count >= p.threshold ? 'var(--state-in)' : 'var(--state-silent-bg)',
        border: '1px solid ' + (d.count >= p.threshold ? 'var(--state-in)' : 'var(--line-structural)'),
        transition: 'var(--transition-meter)'
      }
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        font: 'var(--type-log)',
        lineHeight: 1,
        color: 'var(--text-muted)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      }
    }, d.who.join(', ').toLowerCase())), /*#__PURE__*/React.createElement("span", {
      style: {
        font: 'var(--type-data)',
        textAlign: 'right',
        color: d.count >= p.threshold ? 'var(--state-in-text)' : 'var(--text-muted)'
      }
    }, d.count));
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gap: 'var(--space-7)'
    }
  }, /*#__PURE__*/React.createElement(Panel, {
    title: "Win rule"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gap: 'var(--space-6)'
    }
  }, /*#__PURE__*/React.createElement(Field, {
    label: "Rule"
  }, /*#__PURE__*/React.createElement(Select, {
    options: ['Game minimum', 'Quorum of roster', 'Best available', 'Organiser picks']
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 'var(--space-6)',
      alignItems: 'baseline'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-log)',
      color: 'var(--text-muted)'
    }
  }, "threshold"), /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-data)'
    }
  }, p.threshold, " players")), /*#__PURE__*/React.createElement(Checkbox, {
    checked: true,
    label: "Override always available"
  }), /*#__PURE__*/React.createElement("p", {
    style: {
      font: 'var(--type-small)',
      color: 'var(--text-muted)',
      margin: 0
    }
  }, "Two dates currently clear the threshold. Canonising both mints two game days."))), /*#__PURE__*/React.createElement(Panel, {
    title: "Outcome"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gap: 'var(--space-5)'
    }
  }, picked.length === 0 ? /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-small)',
      color: 'var(--text-muted)'
    }
  }, "Nothing selected.") : picked.map(d => /*#__PURE__*/React.createElement("span", {
    key: d,
    style: {
      font: 'var(--type-body-medium)'
    }
  }, d)), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    full: true
  }, "Canonise ", picked.length, " ", picked.length === 1 ? 'date' : 'dates'), /*#__PURE__*/React.createElement(Button, {
    full: true
  }, "Close poll without minting"))))));
}
Object.assign(window, {
  PollPage
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/console/PollPage.jsx", error: String((e && e.message) || e) }); }

// ui_kits/console/data.js
try { (() => {
window.ORREY = {
  campaigns: [{
    id: 'umbra',
    name: 'Age of Umbra',
    color: 'var(--campaign-1)',
    state: 'RUNNING',
    quorum: 4,
    roster: 6,
    cadence: 'Thursdays, every week',
    next: '2d',
    channel: '#age-of-umbra',
    gm: 'Rowan',
    sessions: 14
  }, {
    id: 'salt',
    name: 'The Salt Road',
    color: 'var(--campaign-2)',
    state: 'RUNNING',
    quorum: 5,
    roster: 5,
    cadence: 'Sundays, every 2 weeks',
    next: '5d',
    channel: '#the-salt-road',
    gm: 'Priya',
    sessions: 7
  }, {
    id: 'hollow',
    name: 'Hollowmere',
    color: 'var(--campaign-3)',
    state: 'FORMING',
    quorum: 4,
    roster: 5,
    cadence: 'Tuesdays, every 2 weeks',
    next: '9d',
    channel: '#hollowmere',
    gm: 'Dev',
    sessions: 0
  }, {
    id: 'ivy',
    name: 'Iron & Ivy',
    color: 'var(--campaign-idle)',
    state: 'HIATUS',
    quorum: 4,
    roster: 4,
    cadence: 'Paused',
    next: '—',
    channel: '#iron-and-ivy',
    gm: 'Jodie',
    sessions: 31
  }],
  people: [{
    id: 'rowan',
    name: 'Rowan',
    initials: 'RW',
    dm: 'open',
    flake: 0.04,
    on: ['umbra', 'salt']
  }, {
    id: 'tam',
    name: 'Tam',
    initials: 'TK',
    dm: 'open',
    flake: 0.11,
    on: ['umbra', 'salt']
  }, {
    id: 'jodie',
    name: 'Jodie',
    initials: 'JD',
    dm: 'closed',
    flake: 0.02,
    on: ['umbra', 'hollow']
  }, {
    id: 'priya',
    name: 'Priya',
    initials: 'PS',
    dm: 'open',
    flake: 0.00,
    on: ['umbra', 'salt']
  }, {
    id: 'marco',
    name: 'Marco',
    initials: 'MC',
    dm: 'open',
    flake: 0.23,
    on: ['umbra', 'hollow']
  }, {
    id: 'elle',
    name: 'Elle',
    initials: 'EL',
    dm: 'unknown',
    flake: 0.09,
    on: ['umbra', 'hollow']
  }, {
    id: 'dev',
    name: 'Dev',
    initials: 'DV',
    dm: 'open',
    flake: 0.05,
    on: ['salt', 'hollow']
  }],
  agenda: [{
    id: 's14',
    day: 'Thu 02 October',
    rel: 'in 2 days',
    when: 'THU 02',
    time: '19:30',
    campaign: 'umbra',
    title: 'Age of Umbra · S14',
    sub: 'the gate under callow hill',
    kind: 'campaign_session',
    state: 'confirmed',
    venue: 'The Foundry',
    roster: [['rowan', 'in', 'GM'], ['tam', 'in'], ['jodie', 'in'], ['priya', 'in'], ['marco', 'out', '', 'work'], ['elle', 'silent']]
  }, {
    id: 's07',
    day: 'Sun 05 October',
    rel: 'in 5 days',
    when: 'SUN 05',
    time: '14:00',
    campaign: 'salt',
    title: 'The Salt Road · S07',
    sub: 'caravan to meret',
    kind: 'campaign_session',
    state: 'jeopardy',
    venue: 'Voice · The Long Table',
    roster: [['priya', 'in', 'GM'], ['tam', 'in'], ['dev', 'maybe'], ['rowan', 'silent'], ['jodie', 'silent']]
  }, {
    id: 's22',
    day: 'Tue 07 October',
    rel: 'in 7 days',
    when: 'TUE 07',
    time: '20:00',
    campaign: 'hollow',
    title: 'Hollowmere · S01',
    sub: 'session zero',
    kind: 'campaign_session',
    state: 'confirmed',
    venue: 'Voice · Hollowmere',
    roster: [['dev', 'in', 'GM'], ['elle', 'in'], ['jodie', 'in'], ['marco', 'in'], ['priya', 'in']]
  }, {
    id: 's15',
    day: 'Thu 09 October',
    rel: 'in 9 days',
    when: 'THU 09',
    time: '19:30',
    campaign: 'umbra',
    title: 'Age of Umbra · S15',
    sub: '—',
    kind: 'campaign_session',
    state: 'open',
    venue: 'The Foundry',
    roster: [['rowan', 'in', 'GM'], ['tam', 'silent'], ['jodie', 'silent'], ['priya', 'silent'], ['marco', 'silent'], ['elle', 'silent']]
  }, {
    id: 'gd1',
    day: 'Sat 11 October',
    rel: 'in 11 days',
    when: 'SAT 11',
    time: '12:00',
    campaign: null,
    title: 'Game day · Twilight Imperium',
    sub: 'single · capacity 6 · signups close fri 18:00',
    kind: 'game_day',
    state: 'confirmed',
    venue: 'The Foundry',
    roster: [['rowan', 'in', 'Host'], ['tam', 'in'], ['jodie', 'in'], ['priya', 'in'], ['dev', 'in'], ['marco', 'in']]
  }, {
    id: 's08',
    day: 'Sun 12 October',
    rel: 'in 12 days',
    when: 'SUN 12',
    time: '14:00',
    campaign: 'salt',
    title: 'The Salt Road · S08',
    sub: '—',
    kind: 'campaign_session',
    state: 'unposted',
    venue: 'Voice · The Long Table',
    roster: [['priya', 'silent', 'GM'], ['tam', 'silent'], ['dev', 'silent'], ['rowan', 'silent'], ['jodie', 'silent']]
  }],
  log: [{
    at: '19:02',
    text: 'gcal event orr_5f2a updated',
    tone: 'write'
  }, {
    at: '18:51',
    text: 'priya → in via button'
  }, {
    at: '18:44',
    text: 'marco → out via button, note "work"'
  }, {
    at: '18:31',
    text: '50007 dm blocked for jodie, fell back to channel mention',
    tone: 'error'
  }, {
    at: '17:00',
    text: 'attendance post sent to #age-of-umbra',
    tone: 'write'
  }, {
    at: '16:00',
    text: 'horizon materialised, 2 events per campaign'
  }],
  poll: {
    target: null,
    kind: 'multi',
    winRule: 'Game minimum',
    threshold: 4,
    closes: 'Fri 10 Oct, 18:00',
    dates: [{
      date: 'Sat 04 October',
      count: 3,
      who: ['Rowan', 'Tam', 'Dev']
    }, {
      date: 'Sat 11 October',
      count: 6,
      who: ['Rowan', 'Tam', 'Jodie', 'Priya', 'Dev', 'Marco'],
      winning: true
    }, {
      date: 'Sat 18 October',
      count: 2,
      who: ['Jodie', 'Elle']
    }, {
      date: 'Sun 19 October',
      count: 4,
      who: ['Rowan', 'Priya', 'Dev', 'Elle'],
      winning: true
    }, {
      date: 'Sat 25 October',
      count: 1,
      who: ['Marco']
    }]
  }
};
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/console/data.js", error: String((e && e.message) || e) }); }

// ui_kits/discord/Chrome.jsx
try { (() => {
function DiscordChrome({
  channel,
  children
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '220px 1fr',
      height: '100vh',
      fontFamily: 'var(--font-discord)',
      background: 'var(--discord-bg)'
    }
  }, /*#__PURE__*/React.createElement("nav", {
    style: {
      background: '#2b2d31',
      overflow: 'auto'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: 48,
      display: 'flex',
      alignItems: 'center',
      padding: '0 16px',
      boxShadow: '0 1px 0 rgba(0,0,0,.2)',
      fontSize: 15,
      fontWeight: 600,
      color: '#f2f3f5'
    }
  }, "The Orrey of Worlds"), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '16px 8px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: '.02em',
      textTransform: 'uppercase',
      color: 'var(--discord-muted)',
      padding: '0 8px 4px'
    }
  }, "Campaigns"), window.ORREY_DISCORD.channels.map(c => {
    const on = c.name === channel;
    return /*#__PURE__*/React.createElement("div", {
      key: c.name,
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 8px',
        borderRadius: 4,
        background: on ? '#404249' : 'transparent',
        color: on ? '#f2f3f5' : 'var(--discord-muted)',
        fontSize: 15,
        cursor: 'pointer'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 18,
        lineHeight: 1,
        opacity: .6
      }
    }, c.kind === 'voice' ? '🔊' : '#'), /*#__PURE__*/React.createElement("span", {
      style: {
        fontWeight: on ? 500 : 400
      }
    }, c.name), c.unread && !on && /*#__PURE__*/React.createElement("i", {
      style: {
        marginLeft: 'auto',
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: '#f2f3f5'
      }
    }));
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateRows: '48px 1fr auto',
      minHeight: 0
    }
  }, /*#__PURE__*/React.createElement("header", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '0 16px',
      boxShadow: '0 1px 0 rgba(0,0,0,.2)',
      zIndex: 1
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 20,
      color: 'var(--discord-muted)'
    }
  }, "#"), /*#__PURE__*/React.createElement("b", {
    style: {
      fontSize: 16,
      color: '#f2f3f5'
    }
  }, channel), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 12,
      paddingLeft: 12,
      borderLeft: '1px solid #3f4147',
      fontSize: 13,
      color: 'var(--discord-muted)'
    }
  }, "Orrey posts here. It never edits what it sent.")), /*#__PURE__*/React.createElement("div", {
    style: {
      overflow: 'auto',
      paddingBottom: 16
    }
  }, children), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '0 16px 24px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: '#383a40',
      borderRadius: 8,
      padding: '11px 16px',
      fontSize: 15,
      color: 'var(--discord-muted)'
    }
  }, "Message #", channel))));
}
Object.assign(window, {
  DiscordChrome
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/discord/Chrome.jsx", error: String((e && e.message) || e) }); }

// ui_kits/discord/DiscordApp.jsx
try { (() => {
const ROSTER = [{
  name: 'Rowan',
  intent: 'in'
}, {
  name: 'Tam',
  intent: 'in'
}, {
  name: 'Jodie',
  intent: 'in'
}, {
  name: 'Priya',
  intent: 'in'
}, {
  name: 'Marco',
  intent: 'out'
}, {
  name: 'Elle',
  intent: 'silent'
}];
function DiscordApp() {
  const [roster, setRoster] = React.useState(ROSTER);
  const [asOf, setAsOf] = React.useState('19:02');
  const [picked, setPicked] = React.useState(['Sat 11 Oct']);
  const vote = intent => {
    setRoster(r => r.map(p => p.name === 'Elle' ? {
      ...p,
      intent
    } : p));
    setAsOf(new Date().toTimeString().slice(0, 5));
  };
  const toggle = v => setPicked(s => s.includes(v) ? s.filter(x => x !== v) : [...s, v]);
  return /*#__PURE__*/React.createElement(DiscordChrome, {
    channel: "session-planning"
  }, /*#__PURE__*/React.createElement(AttendancePost, {
    state: {
      roster,
      quorum: 4,
      asOf
    },
    onVote: vote,
    onRefresh: () => setAsOf(new Date().toTimeString().slice(0, 5))
  }), /*#__PURE__*/React.createElement(SignupPost, null), /*#__PURE__*/React.createElement(PollPost, {
    picked: picked,
    onToggle: toggle
  }), /*#__PURE__*/React.createElement(JeopardyNotice, null), /*#__PURE__*/React.createElement(UpcomingReply, null), /*#__PURE__*/React.createElement(RetiredPost, null));
}
ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(DiscordApp, null));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/discord/DiscordApp.jsx", error: String((e && e.message) || e) }); }

// ui_kits/discord/Posts.jsx
try { (() => {
const {
  DiscordMessage,
  DiscordEmbed,
  DiscordButtonRow,
  DiscordSelect,
  EphemeralNote
} = window.OrreyDesignSystem_4c8cbd;
function names(list) {
  return list.length ? list.join(', ') : '—';
}
function AttendancePost({
  state,
  onVote,
  onRefresh
}) {
  const inList = state.roster.filter(r => r.intent === 'in').map(r => r.name);
  const outList = state.roster.filter(r => r.intent === 'out').map(r => r.name);
  const silent = state.roster.filter(r => r.intent === 'silent').map(r => r.name);
  const maybe = state.roster.filter(r => r.intent === 'maybe').map(r => r.name);
  const met = inList.length >= state.quorum;
  return /*#__PURE__*/React.createElement(DiscordMessage, {
    timestamp: "Today at 17:00"
  }, /*#__PURE__*/React.createElement(DiscordEmbed, {
    color: "var(--campaign-1)",
    title: "Age of Umbra \xB7 Session 14",
    description: "Thursday 2 October, 19:30 — 23:00\nThe Foundry · GM Rowan",
    fields: [{
      name: 'In (' + inList.length + ')',
      value: names(inList)
    }, {
      name: 'Out (' + outList.length + ')',
      value: names(outList)
    }, {
      name: 'No reply (' + silent.length + ')',
      value: names(silent)
    }, ...(maybe.length ? [{
      name: 'Maybe (' + maybe.length + ')',
      value: names(maybe),
      inline: false
    }] : [])],
    footer: met ? 'Quorum met — this one runs' : 'Needs ' + (state.quorum - inList.length) + ' more to run',
    asOf: 'as of ' + state.asOf
  }), /*#__PURE__*/React.createElement(DiscordButtonRow, {
    buttons: [{
      label: 'In',
      style: 'success',
      count: inList.length,
      onClick: () => onVote('in')
    }, {
      label: 'Out',
      style: 'danger',
      count: outList.length,
      onClick: () => onVote('out')
    }, {
      label: 'Maybe',
      style: 'secondary',
      onClick: () => onVote('maybe')
    }, {
      label: 'Note',
      style: 'secondary'
    }]
  }), /*#__PURE__*/React.createElement(DiscordButtonRow, {
    buttons: [{
      label: 'Suggest another day',
      style: 'secondary'
    }, {
      label: 'Refresh',
      style: 'secondary',
      onClick: onRefresh
    }]
  }));
}
function SignupPost() {
  return /*#__PURE__*/React.createElement(DiscordMessage, {
    timestamp: "Yesterday at 11:20"
  }, /*#__PURE__*/React.createElement(DiscordEmbed, {
    color: "var(--campaign-5)",
    title: "Game day \xB7 Twilight Imperium",
    description: "Saturday 11 October, 12:00\nThe Foundry · hosted by Rowan · 6 seats",
    fields: [{
      name: 'Seated (6)',
      value: 'Rowan, Tam, Jodie, Priya, Dev, Marco'
    }, {
      name: 'Waitlist (2)',
      value: 'Elle, Sam'
    }, {
      name: 'Out (1)',
      value: 'Kit'
    }],
    footer: "Full \u2014 waitlist promotes automatically",
    asOf: "as of 18:44"
  }), /*#__PURE__*/React.createElement(DiscordButtonRow, {
    buttons: [{
      label: 'Take a seat',
      style: 'success',
      disabled: true
    }, {
      label: 'Waitlist',
      style: 'primary'
    }, {
      label: 'Out',
      style: 'danger'
    }, {
      label: "Can't make this one — suggest a day",
      style: 'secondary'
    }]
  }));
}
function PollPost({
  picked,
  onToggle
}) {
  return /*#__PURE__*/React.createElement(DiscordMessage, {
    timestamp: "Today at 20:14"
  }, /*#__PURE__*/React.createElement(DiscordEmbed, {
    color: "var(--campaign-2)",
    title: "Which Saturdays work?",
    description: "Pre-signup poll · winning dates become game days.\nOne poll may produce several.",
    fields: [{
      name: 'Sat 04 Oct',
      value: '3 · Rowan, Tam, Dev'
    }, {
      name: 'Sat 11 Oct',
      value: '6 · full table'
    }, {
      name: 'Sat 18 Oct',
      value: '2 · Jodie, Elle'
    }],
    footer: "Closes Fri 10 Oct, 18:00 \xB7 threshold 4",
    asOf: "as of 20:14"
  }), /*#__PURE__*/React.createElement(DiscordSelect, {
    open: true,
    placeholder: "Which days can you make?",
    selected: picked,
    onToggle: onToggle,
    options: [{
      label: 'Sat 04 Oct',
      count: 3
    }, {
      label: 'Sat 11 Oct',
      count: 6
    }, {
      label: 'Sat 18 Oct',
      count: 2
    }, {
      label: 'Sun 19 Oct',
      count: 4
    }, {
      label: 'Sat 25 Oct',
      count: 1
    }]
  }), /*#__PURE__*/React.createElement(DiscordButtonRow, {
    buttons: [{
      label: 'Canonise',
      style: 'primary'
    }, {
      label: 'Refresh',
      style: 'secondary'
    }]
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 6,
      fontSize: 12,
      color: 'var(--discord-muted)'
    }
  }, "Canonise is organiser-only."));
}
function JeopardyNotice() {
  return /*#__PURE__*/React.createElement(DiscordMessage, {
    timestamp: "Today at 19:30"
  }, /*#__PURE__*/React.createElement(DiscordEmbed, {
    color: "var(--state-maybe)",
    title: "The Salt Road \xB7 S07 is short",
    description: "Sunday 5 October, 14:00 — 2 in, needs 5.\nThis is a new notice, not an edit: the post above is a snapshot and stays one.",
    footer: "Jeopardy check, T-24h",
    asOf: "as of 19:30"
  }), /*#__PURE__*/React.createElement(DiscordButtonRow, {
    buttons: [{
      label: 'In',
      style: 'success'
    }, {
      label: 'Out',
      style: 'danger'
    }, {
      label: 'Suggest another day',
      style: 'secondary'
    }]
  }));
}
function UpcomingReply() {
  return /*#__PURE__*/React.createElement(DiscordMessage, {
    author: "Orrey",
    timestamp: "Today at 20:31"
  }, /*#__PURE__*/React.createElement(EphemeralNote, null, /*#__PURE__*/React.createElement(DiscordEmbed, {
    color: "var(--signal-500)",
    title: "Upcoming \u2014 for you",
    description: "Everything you are on the roster for, right now. Always current; this is why there is no pinned board.",
    fields: [{
      name: 'Thu 02 Oct, 19:30',
      value: 'Age of Umbra · S14 — you are **in**',
      inline: false
    }, {
      name: 'Sun 05 Oct, 14:00',
      value: 'The Salt Road · S07 — **no reply**, needs 3 more',
      inline: false
    }, {
      name: 'Sat 11 Oct, 12:00',
      value: 'Twilight Imperium — **seated**',
      inline: false
    }],
    asOf: "as of 20:31"
  })));
}
function RetiredPost() {
  return /*#__PURE__*/React.createElement(DiscordMessage, {
    author: "Orrey",
    timestamp: "Today at 20:33"
  }, /*#__PURE__*/React.createElement(EphemeralNote, null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 15,
      color: 'var(--discord-text)',
      marginTop: 6
    }
  }, "This post is retired \u2014 its buttons no longer do anything. Try ", /*#__PURE__*/React.createElement("code", {
    style: {
      background: '#1e1f22',
      padding: '2px 5px',
      borderRadius: 3,
      fontFamily: 'var(--font-mono)',
      fontSize: 13
    }
  }, "/upcoming"), ".")));
}
Object.assign(window, {
  AttendancePost,
  SignupPost,
  PollPost,
  JeopardyNotice,
  UpcomingReply,
  RetiredPost
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/discord/Posts.jsx", error: String((e && e.message) || e) }); }

// ui_kits/discord/data.js
try { (() => {
window.ORREY_DISCORD = {
  channels: [{
    name: 'session-planning',
    kind: 'text',
    unread: true
  }, {
    name: 'age-of-umbra',
    kind: 'text'
  }, {
    name: 'the-salt-road',
    kind: 'text'
  }, {
    name: 'hollowmere',
    kind: 'text'
  }, {
    name: 'game-days',
    kind: 'text'
  }, {
    name: 'the-foundry',
    kind: 'voice'
  }]
};
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/discord/data.js", error: String((e && e.message) || e) }); }

// ui_kits/entry/EntryApp.jsx
try { (() => {
const {
  SegmentedFilter,
  TopBar,
  Wordmark,
  Tag
} = window.OrreyDesignSystem_4c8cbd;
function EntryApp() {
  const [v, setV] = React.useState('Sign in');
  return /*#__PURE__*/React.createElement("div", {
    style: {
      minHeight: '100vh'
    }
  }, /*#__PURE__*/React.createElement(TopBar, null, /*#__PURE__*/React.createElement(Wordmark, null), /*#__PURE__*/React.createElement(Tag, null, "ENTRY POINTS"), /*#__PURE__*/React.createElement("div", {
    style: {
      marginLeft: 'auto'
    }
  }, /*#__PURE__*/React.createElement(SegmentedFilter, {
    options: ['Sign in', 'First run', 'Calendar'],
    value: v,
    onChange: setV
  }))), v === 'Sign in' && /*#__PURE__*/React.createElement(Login, null), v === 'First run' && /*#__PURE__*/React.createElement(FirstRun, null), v === 'Calendar' && /*#__PURE__*/React.createElement(CalendarView, null));
}
ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(EntryApp, null));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/entry/EntryApp.jsx", error: String((e && e.message) || e) }); }

// ui_kits/entry/Screens.jsx
try { (() => {
const {
  Wordmark,
  Button,
  Panel,
  Field,
  Input,
  Select,
  Checkbox,
  Pill,
  Tag,
  SyncChip,
  StatusBar,
  StatusItem,
  DataTable,
  Cell
} = window.OrreyDesignSystem_4c8cbd;
function Shell({
  children,
  wide
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      minHeight: '100vh',
      display: 'grid',
      placeItems: 'center',
      padding: 'var(--space-10)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: wide ? 720 : 420,
      maxWidth: '100%'
    }
  }, children));
}
function Login() {
  return /*#__PURE__*/React.createElement(Shell, null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--space-9)'
    }
  }, /*#__PURE__*/React.createElement(Wordmark, {
    size: 22
  }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h1", {
    style: {
      font: 'var(--type-heading)',
      margin: '0 0 var(--space-4)'
    }
  }, "Sign in"), /*#__PURE__*/React.createElement("p", {
    style: {
      font: 'var(--type-small)',
      color: 'var(--text-secondary)',
      margin: 0,
      maxWidth: '44ch'
    }
  }, "Discord is the only identity system. Orrey asks for ", /*#__PURE__*/React.createElement("code", {
    style: {
      font: 'var(--type-log)',
      color: 'var(--text-primary)'
    }
  }, "identify"), " and nothing else \u2014 your roles are read with the bot token, and the list of servers you are in is never requested.")), /*#__PURE__*/React.createElement("button", {
    style: {
      height: 'var(--control-lg)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      background: 'var(--discord-blurple)',
      color: '#fff',
      border: 0,
      borderRadius: 'var(--radius-none)',
      fontFamily: 'var(--font-ui)',
      fontWeight: 500,
      fontSize: 14,
      cursor: 'pointer'
    }
  }, "Continue with Discord"), /*#__PURE__*/React.createElement("div", {
    style: {
      borderTop: '1px solid var(--line-hair)',
      paddingTop: 'var(--space-6)',
      display: 'flex',
      gap: 'var(--space-7)'
    }
  }, /*#__PURE__*/React.createElement("a", {
    href: "#",
    style: {
      font: 'var(--type-small)'
    }
  }, "Privacy"), /*#__PURE__*/React.createElement("a", {
    href: "#",
    style: {
      font: 'var(--type-small)'
    }
  }, "Delete my data"), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 'auto',
      font: 'var(--type-log)',
      color: 'var(--text-muted)'
    }
  }, "phase 2"))));
}
function FirstRun() {
  const rows = [['Guild', 'the Orrey of Worlds', 'ok'], ['Scheduling channel', '#session-planning', 'ok'], ['Campaign roles', '4 adopted from Hermuz', 'ok'], ['Campaign channels', '4 adopted from Hermuz', 'ok'], ['Live scheduled events', '7 adopted', 'ok'], ['Orrey calendar', 'service account granted writer', 'pending']];
  return /*#__PURE__*/React.createElement(Shell, {
    wide: true
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--space-6)',
      marginBottom: 'var(--space-8)'
    }
  }, /*#__PURE__*/React.createElement(Wordmark, {
    size: 16
  }), /*#__PURE__*/React.createElement(Tag, null, "FIRST RUN"), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 'auto',
      font: 'var(--type-log)',
      color: 'var(--text-muted)'
    }
  }, "step 2 of 3")), /*#__PURE__*/React.createElement(Panel, {
    title: "Adopted Discord ids",
    meta: "no data is imported",
    flush: true
  }, /*#__PURE__*/React.createElement(DataTable, {
    columns: [{
      label: 'Object',
      width: 200
    }, {
      label: 'Value'
    }, {
      label: 'State',
      width: 120
    }]
  }, rows.map(([k, v, s]) => /*#__PURE__*/React.createElement("tr", {
    key: k,
    style: {
      borderBottom: '1px solid var(--line-hair)'
    }
  }, /*#__PURE__*/React.createElement(Cell, {
    style: {
      font: 'var(--type-body-medium)'
    }
  }, k), /*#__PURE__*/React.createElement(Cell, {
    style: {
      font: 'var(--type-log)',
      color: 'var(--text-secondary)'
    }
  }, v), /*#__PURE__*/React.createElement(Cell, null, /*#__PURE__*/React.createElement(Pill, {
    tone: s === 'ok' ? 'in' : 'maybe'
  }, s === 'ok' ? 'adopted' : 'pending')))))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 'var(--space-8)'
    }
  }, /*#__PURE__*/React.createElement(Panel, {
    title: "Enter a campaign",
    meta: "four, by hand"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr 1fr',
      gap: 'var(--space-6)'
    }
  }, /*#__PURE__*/React.createElement(Field, {
    label: "Name"
  }, /*#__PURE__*/React.createElement(Input, {
    defaultValue: "Age of Umbra"
  })), /*#__PURE__*/React.createElement(Field, {
    label: "Kind"
  }, /*#__PURE__*/React.createElement(Select, {
    options: ['Run', 'Play', 'Tracked']
  })), /*#__PURE__*/React.createElement(Field, {
    label: "First session number",
    hint: "History starts empty."
  }, /*#__PURE__*/React.createElement(Input, {
    defaultValue: "14"
  })), /*#__PURE__*/React.createElement(Field, {
    label: "Anchor date"
  }, /*#__PURE__*/React.createElement(Input, {
    defaultValue: "2025-02-06"
  })), /*#__PURE__*/React.createElement(Field, {
    label: "Interval (weeks)"
  }, /*#__PURE__*/React.createElement(Input, {
    defaultValue: "1"
  })), /*#__PURE__*/React.createElement(Field, {
    label: "Quorum"
  }, /*#__PURE__*/React.createElement(Input, {
    defaultValue: "4"
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 'var(--space-4)',
      marginTop: 'var(--space-7)',
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement(Checkbox, {
    checked: true,
    label: "Point at the adopted role and channel"
  }), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    style: {
      marginLeft: 'auto'
    }
  }, "Save campaign 1 of 4")))), /*#__PURE__*/React.createElement("p", {
    style: {
      font: 'var(--type-small)',
      color: 'var(--text-muted)',
      marginTop: 'var(--space-7)'
    }
  }, "Session numbers need seeding and history starts empty, so flake memory says nothing for a couple of months. Both are known costs of a fresh database."));
}
function CalendarView() {
  const days = ['Mon 29', 'Tue 30', 'Wed 01', 'Thu 02', 'Fri 03', 'Sat 04', 'Sun 05'];
  const events = [{
    day: 3,
    start: 19.5,
    end: 23,
    label: 'Age of Umbra · S14',
    color: 'var(--campaign-1)'
  }, {
    day: 6,
    start: 14,
    end: 18,
    label: 'The Salt Road · S07',
    color: 'var(--campaign-2)'
  }, {
    day: 1,
    start: 20,
    end: 23,
    label: 'Hollowmere · S01',
    color: 'var(--campaign-3)'
  }];
  const H = 18,
    START = 12;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 'var(--space-9)',
      minHeight: '100vh'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--space-6)',
      marginBottom: 'var(--space-7)'
    }
  }, /*#__PURE__*/React.createElement("h1", {
    style: {
      font: 'var(--type-title)',
      margin: 0
    }
  }, "Orrey calendar"), /*#__PURE__*/React.createElement(Pill, {
    tone: "idle"
  }, "projection"), /*#__PURE__*/React.createElement(Tag, null, "ics feed \xB7 per campaign"), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 'auto',
      font: 'var(--type-small)',
      color: 'var(--text-muted)'
    }
  }, "Orrey writes here and nowhere else. Your Social calendar is never touched.")), /*#__PURE__*/React.createElement("div", {
    style: {
      border: '1px solid var(--line-structural)',
      background: 'var(--surface-chrome)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '56px repeat(7,1fr)',
      borderBottom: '1px solid var(--line-structural)'
    }
  }, /*#__PURE__*/React.createElement("div", null), days.map(d => /*#__PURE__*/React.createElement("div", {
    key: d,
    style: {
      padding: 'var(--space-5) var(--space-4)',
      font: 'var(--type-micro)',
      letterSpacing: 'var(--tracking-label)',
      textTransform: 'uppercase',
      color: 'var(--text-muted)',
      borderLeft: '1px solid var(--line-hair)'
    }
  }, d))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '56px repeat(7,1fr)',
      position: 'relative',
      height: 11 * 32
    }
  }, /*#__PURE__*/React.createElement("div", null, Array.from({
    length: 11
  }, (_, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      height: 32,
      font: 'var(--type-log)',
      lineHeight: '32px',
      color: 'var(--text-muted)',
      textAlign: 'right',
      paddingRight: 8,
      borderBottom: '1px solid var(--line-hair)'
    }
  }, String(START + i).padStart(2, '0')))), days.map((d, di) => /*#__PURE__*/React.createElement("div", {
    key: d,
    style: {
      position: 'relative',
      borderLeft: '1px solid var(--line-hair)'
    }
  }, Array.from({
    length: 11
  }, (_, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      height: 32,
      borderBottom: '1px solid var(--line-hair)'
    }
  })), events.filter(e => e.day === di).map(e => /*#__PURE__*/React.createElement("div", {
    key: e.label,
    style: {
      position: 'absolute',
      left: 2,
      right: 2,
      top: (e.start - START) * 32,
      height: (e.end - e.start) * 32,
      background: 'var(--surface-raised)',
      borderLeft: '3px solid ' + e.color,
      padding: '6px 8px',
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-data)',
      color: 'var(--text-primary)'
    }
  }, String(Math.floor(e.start)).padStart(2, '0'), ":", e.start % 1 ? '30' : '00'), /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-small)',
      color: 'var(--text-secondary)',
      marginTop: 2
    }
  }, e.label))))))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 'var(--space-8)',
      marginTop: 'var(--space-8)'
    }
  }, /*#__PURE__*/React.createElement(Panel, {
    title: "Event detail"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gap: 'var(--space-4)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-heading)'
    }
  }, "Age of Umbra \xB7 S14"), /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-log)',
      color: 'var(--text-secondary)'
    }
  }, "thu 02 oct \xB7 19:30 \u2014 23:00 \xB7 the foundry"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 'var(--space-3)',
      marginTop: 'var(--space-3)',
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement(Tag, null, "orr_5f2a"), /*#__PURE__*/React.createElement(Tag, null, "fingerprint 8c1d"), /*#__PURE__*/React.createElement(Pill, {
    tone: "in"
  }, "synced")), /*#__PURE__*/React.createElement("p", {
    style: {
      font: 'var(--type-small)',
      color: 'var(--text-muted)',
      margin: 'var(--space-4) 0 0'
    }
  }, "Ids are minted by Orrey in base32hex: insert, and on 409, update. The fingerprint is what stops the return path echoing."))), /*#__PURE__*/React.createElement(Panel, {
    title: "Attendees"
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      font: 'var(--type-small)',
      color: 'var(--text-secondary)',
      margin: 0
    }
  }, "Orrey does not RSVP on anyone's behalf. Google's ", /*#__PURE__*/React.createElement("code", {
    style: {
      font: 'var(--type-log)'
    }
  }, "responseStatus"), " is left alone; the authoritative answer is in Orrey and shown in Discord."))));
}
Object.assign(window, {
  Login,
  FirstRun,
  CalendarView
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/entry/Screens.jsx", error: String((e && e.message) || e) }); }

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Checkbox = __ds_scope.Checkbox;

__ds_ns.Field = __ds_scope.Field;

__ds_ns.Input = __ds_scope.Input;

__ds_ns.Panel = __ds_scope.Panel;

__ds_ns.Pill = __ds_scope.Pill;

__ds_ns.Select = __ds_scope.Select;

__ds_ns.Tag = __ds_scope.Tag;

__ds_ns.DataTable = __ds_scope.DataTable;

__ds_ns.Cell = __ds_scope.Cell;

__ds_ns.DayHeader = __ds_scope.DayHeader;

__ds_ns.QuorumMeter = __ds_scope.QuorumMeter;

__ds_ns.Avatar = __ds_scope.Avatar;

__ds_ns.RosterRow = __ds_scope.RosterRow;

__ds_ns.SessionRow = __ds_scope.SessionRow;

__ds_ns.SyncLog = __ds_scope.SyncLog;

__ds_ns.DiscordButtonRow = __ds_scope.DiscordButtonRow;

__ds_ns.DiscordEmbed = __ds_scope.DiscordEmbed;

__ds_ns.DiscordMessage = __ds_scope.DiscordMessage;

__ds_ns.DiscordSelect = __ds_scope.DiscordSelect;

__ds_ns.EphemeralNote = __ds_scope.EphemeralNote;

__ds_ns.SegmentedFilter = __ds_scope.SegmentedFilter;

__ds_ns.Sidebar = __ds_scope.Sidebar;

__ds_ns.SidebarSection = __ds_scope.SidebarSection;

__ds_ns.NavItem = __ds_scope.NavItem;

__ds_ns.StatusBar = __ds_scope.StatusBar;

__ds_ns.StatusItem = __ds_scope.StatusItem;

__ds_ns.SyncChip = __ds_scope.SyncChip;

__ds_ns.TopBar = __ds_scope.TopBar;

__ds_ns.Wordmark = __ds_scope.Wordmark;

})();
