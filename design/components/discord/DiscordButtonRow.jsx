import React from 'react';

const styles={
  primary:{background:'var(--discord-blurple)',color:'#fff'},
  secondary:{background:'var(--discord-grey-btn)',color:'#fff'},
  success:{background:'var(--discord-green)',color:'#fff'},
  danger:{background:'var(--discord-red)',color:'#fff'},
  link:{background:'var(--discord-grey-btn)',color:'#fff'}
};

export function DiscordButtonRow({buttons=[],style,...rest}){
  return (
    <div style={{display:'flex',flexWrap:'wrap',gap:'var(--space-4)',
      marginTop:'var(--space-4)',maxWidth:520,fontFamily:'var(--font-discord)',...style}} {...rest}>
      {buttons.slice(0,5).map((b,i)=>(
        <button key={i} type="button" disabled={b.disabled} onClick={b.onClick}
          style={{...styles[b.style||'secondary'],border:0,borderRadius:3,
            height:32,padding:'0 16px',fontSize:14,fontWeight:500,
            fontFamily:'inherit',cursor:b.disabled?'not-allowed':'pointer',
            opacity:b.disabled?0.5:1,display:'inline-flex',alignItems:'center',gap:6}}>
          {b.emoji&&<span>{b.emoji}</span>}{b.label}{b.count!=null&&<span style={{opacity:.7}}>{b.count}</span>}
        </button>
      ))}
    </div>
  );
}
