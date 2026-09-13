import React from 'react';

export function DiscordMessage({author='Orrey',bot=true,timestamp,avatarInitials='OR',children,style,...rest}){
  return (
    <div style={{display:'flex',gap:'var(--space-7)',padding:'var(--space-4) var(--space-8)',
      background:'var(--discord-bg)',fontFamily:'var(--font-discord)',
      color:'var(--discord-text)',...style}} {...rest}>
      <i style={{width:40,height:40,flex:'none',borderRadius:'var(--radius-circle)',
        background:'var(--slate-950)',display:'grid',placeItems:'center',
        font:'var(--font-ui)',fontWeight:700,fontSize:13,letterSpacing:'0.06em',
        fontStyle:'normal',color:'var(--signal-500)'}}>{avatarInitials}</i>
      <div style={{minWidth:0,flex:1}}>
        <div style={{display:'flex',alignItems:'center',gap:'var(--space-4)',marginBottom:2}}>
          <b style={{fontSize:15,fontWeight:600,color:'#f2f3f5'}}>{author}</b>
          {bot&&<span style={{background:'var(--discord-blurple)',color:'#fff',fontSize:10,
            fontWeight:600,padding:'1px 4px',borderRadius:3,letterSpacing:'.02em'}}>APP</span>}
          <span style={{fontSize:12,color:'var(--discord-muted)'}}>{timestamp}</span>
        </div>
        {children}
      </div>
    </div>
  );
}
