function DiscordChrome({channel,children}){
  return (
    <div style={{display:'grid',gridTemplateColumns:'220px 1fr',height:'100vh',
      fontFamily:'var(--font-discord)',background:'var(--discord-bg)'}}>
      <nav style={{background:'#2b2d31',overflow:'auto'}}>
        <div style={{height:48,display:'flex',alignItems:'center',padding:'0 16px',
          boxShadow:'0 1px 0 rgba(0,0,0,.2)',fontSize:15,fontWeight:600,color:'#f2f3f5'}}>
          The Orrey of Worlds</div>
        <div style={{padding:'16px 8px'}}>
          <div style={{fontSize:11,fontWeight:700,letterSpacing:'.02em',textTransform:'uppercase',
            color:'var(--discord-muted)',padding:'0 8px 4px'}}>Campaigns</div>
          {window.ORREY_DISCORD.channels.map(c=>{
            const on=c.name===channel;
            return (
              <div key={c.name} style={{display:'flex',alignItems:'center',gap:6,padding:'6px 8px',
                borderRadius:4,background:on?'#404249':'transparent',
                color:on?'#f2f3f5':'var(--discord-muted)',fontSize:15,cursor:'pointer'}}>
                <span style={{fontSize:18,lineHeight:1,opacity:.6}}>{c.kind==='voice'?'🔊':'#'}</span>
                <span style={{fontWeight:on?500:400}}>{c.name}</span>
                {c.unread&&!on&&<i style={{marginLeft:'auto',width:6,height:6,borderRadius:'50%',background:'#f2f3f5'}}/>}
              </div>
            );
          })}
        </div>
      </nav>
      <div style={{display:'grid',gridTemplateRows:'48px 1fr auto',minHeight:0}}>
        <header style={{display:'flex',alignItems:'center',gap:8,padding:'0 16px',
          boxShadow:'0 1px 0 rgba(0,0,0,.2)',zIndex:1}}>
          <span style={{fontSize:20,color:'var(--discord-muted)'}}>#</span>
          <b style={{fontSize:16,color:'#f2f3f5'}}>{channel}</b>
          <span style={{marginLeft:12,paddingLeft:12,borderLeft:'1px solid #3f4147',
            fontSize:13,color:'var(--discord-muted)'}}>Orrey posts here. It never edits what it sent.</span>
        </header>
        <div style={{overflow:'auto',paddingBottom:16}}>{children}</div>
        <div style={{padding:'0 16px 24px'}}>
          <div style={{background:'#383a40',borderRadius:8,padding:'11px 16px',
            fontSize:15,color:'var(--discord-muted)'}}>Message #{channel}</div>
        </div>
      </div>
    </div>
  );
}
Object.assign(window,{DiscordChrome});
