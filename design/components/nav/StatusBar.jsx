import React from 'react';

export function StatusBar({children,style,...rest}){
  return (
    <footer style={{display:'flex',alignItems:'center',gap:'var(--space-8)',
      height:'var(--chrome-statusbar)',padding:'0 var(--space-7)',
      background:'var(--surface-chrome)',borderTop:'1px solid var(--line-structural)',
      font:'var(--type-log)',lineHeight:1,letterSpacing:'var(--tracking-data)',
      color:'var(--text-muted)',...style}} {...rest}>{children}</footer>
  );
}

export function StatusItem({label,value,style,...rest}){
  return (
    <span style={{display:'inline-flex',gap:'var(--space-3)',...style}} {...rest}>
      {label}{value!=null&&<b style={{color:'var(--text-secondary)',fontWeight:400}}>{value}</b>}
    </span>
  );
}
