import React from 'react';

export function SyncLog({entries=[],style,...rest}){
  return (
    <div style={{font:'var(--type-log)',color:'var(--text-muted)',...style}} {...rest}>
      {entries.map((e,i)=>(
        <div key={i} style={{display:'flex',gap:'var(--space-4)'}}>
          <b style={{color:'var(--text-secondary)',fontWeight:400,flex:'none'}}>{e.at}</b>
          <span style={{color:e.tone==='error'?'var(--state-out-text)':e.tone==='write'?'var(--text-secondary)':'inherit'}}>{e.text}</span>
        </div>
      ))}
    </div>
  );
}
