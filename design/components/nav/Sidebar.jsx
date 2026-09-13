import React from 'react';

export function Sidebar({children,style,...rest}){
  return (
    <nav style={{width:'var(--chrome-sidebar)',flex:'none',overflow:'auto',
      background:'var(--surface-chrome)',borderRight:'1px solid var(--line-structural)',
      ...style}} {...rest}>{children}</nav>
  );
}

export function SidebarSection({label,count,style,...rest}){
  return (
    <div style={{display:'flex',gap:'var(--space-3)',
      font:'var(--type-micro)',letterSpacing:'var(--tracking-label)',textTransform:'uppercase',
      color:'var(--text-muted)',padding:'var(--space-7) var(--space-7) var(--space-4)',
      borderBottom:'1px solid var(--line-hair)',...style}} {...rest}>
      <span>{label}</span>{count!=null&&<span>· {count}</span>}
    </div>
  );
}

export function NavItem({color,label,meta,active=false,onClick,style,...rest}){
  const [hot,setHot]=React.useState(false);
  return (
    <div onClick={onClick} onMouseEnter={()=>setHot(true)} onMouseLeave={()=>setHot(false)}
      style={{display:'flex',alignItems:'center',gap:'var(--space-4)',
        padding:'var(--space-4) var(--space-7)',cursor:'pointer',
        borderBottom:'1px solid var(--line-hair)',
        background:active||hot?'var(--surface-raised)':'transparent',
        boxShadow:active?'var(--marker-selected)':'none',
        transition:'var(--transition-hover)',...style}} {...rest}>
      {color&&<i style={{width:7,height:7,flex:'none',background:color}}/>}
      <span style={{flex:1,font:'var(--type-body-medium)',fontSize:'var(--size-small)'}}>{label}</span>
      {meta!=null&&<span style={{font:'var(--type-log)',lineHeight:1,color:'var(--text-muted)'}}>{meta}</span>}
    </div>
  );
}
