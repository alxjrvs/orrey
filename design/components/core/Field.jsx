import React from 'react';

export function Field({label,hint,error,required=false,children,style,...rest}){
  return (
    <label style={{display:'block',...style}} {...rest}>
      {label&&(
        <span style={{display:'flex',gap:'var(--space-3)',alignItems:'baseline',
          font:'var(--type-label)',letterSpacing:'var(--tracking-label)',textTransform:'uppercase',
          color:'var(--text-muted)',marginBottom:'var(--space-4)'}}>
          {label}{required&&<i style={{color:'var(--signal-500)',fontStyle:'normal'}}>*</i>}
        </span>
      )}
      {children}
      {(hint||error)&&(
        <span style={{display:'block',marginTop:'var(--space-3)',font:'var(--type-small)',
          color:error?'var(--state-out-text)':'var(--text-muted)'}}>{error||hint}</span>
      )}
    </label>
  );
}

export function Input({invalid=false,style,...rest}){
  const [hot,setHot]=React.useState(false);
  return (
    <input onFocus={()=>setHot(true)} onBlur={()=>setHot(false)}
      style={{width:'100%',height:'var(--control-md)',padding:'0 var(--space-5)',
        background:'var(--surface-sunken)',color:'var(--text-primary)',
        border:'1px solid '+(invalid?'var(--state-out-line)':hot?'var(--signal-500)':'var(--line-structural)'),
        borderRadius:'var(--radius-none)',font:'var(--type-body)',outline:'none',
        transition:'var(--transition-hover)',...style}} {...rest}/>
  );
}
