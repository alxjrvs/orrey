import React from 'react';

export function DiscordSelect({placeholder='Select dates',options=[],open=false,selected=[],onToggle,style,...rest}){
  return (
    <div style={{maxWidth:400,marginTop:'var(--space-4)',fontFamily:'var(--font-discord)',...style}} {...rest}>
      <div style={{display:'flex',alignItems:'center',gap:8,height:38,padding:'0 12px',
        background:'var(--discord-bg-alt)',border:'1px solid rgba(0,0,0,.3)',borderRadius:4,
        color:selected.length?'var(--discord-text)':'var(--discord-muted)',fontSize:14,cursor:'pointer'}}>
        <span style={{flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
          {selected.length?selected.join(', '):placeholder}
        </span>
        <i style={{width:0,height:0,borderLeft:'4px solid transparent',borderRight:'4px solid transparent',
          borderTop:'5px solid var(--discord-muted)'}}/>
      </div>
      {open&&(
        <div style={{marginTop:4,background:'var(--discord-bg-alt)',borderRadius:4,
          boxShadow:'var(--shadow-discord)',padding:'6px 0',maxHeight:220,overflow:'auto'}}>
          {options.map((o,i)=>{
            const v=typeof o==='string'?o:o.label;
            const on=selected.includes(v);
            return (
              <div key={i} onClick={()=>onToggle&&onToggle(v)}
                style={{display:'flex',alignItems:'center',gap:10,padding:'7px 12px',cursor:'pointer',
                  background:on?'rgba(88,101,242,.15)':'transparent',fontSize:14}}>
                <i style={{width:14,height:14,flex:'none',borderRadius:3,
                  border:'1px solid '+(on?'var(--discord-blurple)':'var(--discord-muted)'),
                  background:on?'var(--discord-blurple)':'transparent'}}/>
                <span style={{flex:1,color:'var(--discord-text)'}}>{v}</span>
                {typeof o==='object'&&o.count!=null&&(
                  <span style={{fontSize:12,color:'var(--discord-muted)'}}>{o.count}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
