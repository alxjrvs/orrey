import React from 'react';

export function DiscordEmbed({color='var(--campaign-1)',title,url,description,fields=[],asOf,footer,style,...rest}){
  return (
    <div style={{display:'flex',maxWidth:520,background:'var(--discord-embed)',
      borderRadius:'var(--radius-discord)',overflow:'hidden',fontFamily:'var(--font-discord)',
      marginTop:'var(--space-3)',...style}} {...rest}>
      <i style={{width:4,flex:'none',background:color}}/>
      <div style={{padding:'var(--space-6) var(--space-7) var(--space-7)',minWidth:0,flex:1}}>
        {title&&<div style={{fontSize:16,fontWeight:600,color:url?'var(--discord-link)':'#f2f3f5',
          marginBottom:'var(--space-4)'}}>{title}</div>}
        {description&&<div style={{fontSize:14,lineHeight:1.45,color:'var(--discord-text)',
          whiteSpace:'pre-wrap'}}>{description}</div>}
        {fields.length>0&&(
          <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:'var(--space-4) var(--space-4)',
            marginTop:'var(--space-6)'}}>
            {fields.map((fd,i)=>(
              <div key={i} style={{gridColumn:fd.inline===false?'1 / -1':'auto'}}>
                <div style={{fontSize:13,fontWeight:600,color:'#f2f3f5',marginBottom:2}}>{fd.name}</div>
                <div style={{fontSize:13,lineHeight:1.4,color:'var(--discord-text)',whiteSpace:'pre-wrap'}}>{fd.value}</div>
              </div>
            ))}
          </div>
        )}
        {(asOf||footer)&&(
          <div style={{display:'flex',gap:'var(--space-4)',marginTop:'var(--space-6)',
            fontSize:12,color:'var(--discord-muted)'}}>
            {footer&&<span>{footer}</span>}{footer&&asOf&&<span>·</span>}{asOf&&<span>{asOf}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
