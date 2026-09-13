import React from 'react';

const colors={ok:'var(--state-in)',stale:'var(--state-maybe)',down:'var(--state-out)',off:'var(--text-muted)'};

export function SyncChip({status='ok',label,children,style,...rest}){
  return (
    <div style={{display:'flex',alignItems:'center',gap:'var(--space-3)',
      height:'var(--chrome-topbar)',padding:'0 var(--space-6)',
      borderLeft:'1px solid var(--line-structural)',
      font:'var(--type-log)',fontSize:'var(--size-label)',lineHeight:1,
      letterSpacing:'var(--tracking-data)',textTransform:'uppercase',
      color:'var(--text-secondary)',...style}} {...rest}>
      {status&&<i style={{width:5,height:5,background:colors[status],flex:'none'}}/>}
      {label||children}
    </div>
  );
}
