import React from 'react';

export function EphemeralNote({children,dismissable=true,style,...rest}){
  return (
    <div style={{maxWidth:520,marginTop:'var(--space-4)',fontFamily:'var(--font-discord)',...style}} {...rest}>
      <div>{children}</div>
      <div style={{display:'flex',alignItems:'center',gap:6,marginTop:'var(--space-4)',
        fontSize:12,color:'var(--discord-muted)'}}>
        <i style={{width:12,height:12,borderRadius:'var(--radius-circle)',
          border:'1px solid var(--discord-muted)',display:'grid',placeItems:'center',
          fontSize:8,fontStyle:'normal',lineHeight:1}}>i</i>
        <span>Only you can see this{dismissable&&<> · <a href="#" style={{color:'var(--discord-link)'}}>Dismiss message</a></>}</span>
      </div>
    </div>
  );
}
