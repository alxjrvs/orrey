import React from 'react';

const states={
  in:{label:'In',color:'var(--state-in-text)'},
  out:{label:'Out',color:'var(--state-out-text)'},
  maybe:{label:'Maybe',color:'var(--state-maybe-text)'},
  silent:{label:'—',color:'var(--text-muted)'}
};

export function Avatar({initials,tone,size=20,style,...rest}){
  return (
    <i style={{width:size,height:size,flex:'none',display:'grid',placeItems:'center',
      background:tone||'var(--surface-raised)',border:'1px solid var(--line-structural)',
      font:'var(--font-mono)',fontWeight:500,fontSize:'var(--size-micro)',fontStyle:'normal',
      color:'var(--text-secondary)',...style}} {...rest}>{initials}</i>
  );
}

export function RosterRow({name,initials,role,intent='silent',attended,note,style,...rest}){
  const s=states[intent]||states.silent;
  return (
    <div style={{display:'flex',alignItems:'center',gap:'var(--space-4)',
      padding:'var(--space-3) 0',...style}} {...rest}>
      <Avatar initials={initials}/>
      <span style={{font:'var(--type-small)'}}>
        {name}{role&&<span style={{color:'var(--text-muted)'}}> ({role})</span>}
      </span>
      {note&&<span style={{font:'var(--type-log)',lineHeight:1,color:'var(--text-muted)'}}>{note}</span>}
      <span style={{marginLeft:'auto',display:'flex',alignItems:'center',gap:'var(--space-4)'}}>
        {attended!=null&&(
          <i style={{width:10,height:10,border:'1px solid '+(attended?'var(--state-in)':'var(--line-strong)'),
            background:attended?'var(--state-in)':'transparent',fontStyle:'normal'}}/>
        )}
        <span style={{font:'var(--type-label)',fontWeight:500,letterSpacing:'0.06em',
          textTransform:'uppercase',color:s.color}}>{s.label}</span>
      </span>
    </div>
  );
}
