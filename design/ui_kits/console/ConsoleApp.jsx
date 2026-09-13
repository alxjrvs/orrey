const {TopBar,Wordmark,Tag,SyncChip,Sidebar,SidebarSection,NavItem,StatusBar,StatusItem}=window.OrreyDesignSystem_4c8cbd;

function ConsoleApp(){
  const [view,setView]=React.useState({kind:'agenda',mode:'scheduling'});
  const [grouped,setGrouped]=React.useState(true);
  const [filter,setFilter]=React.useState('All');
  const [sel,setSel]=React.useState(window.unsettledIds()[0]);
  const goAgenda=mode=>{setView({kind:'agenda',mode});setFilter('All');
    setSel((mode==='scheduling'?window.unsettledIds():window.settledIds())[0]);};
  const item=window.ORREY.agenda.find(a=>a.id===sel);

  return (
    <div style={{display:'grid',gridTemplateRows:'auto 1fr auto',height:'100vh',minHeight:0}}>
      <TopBar>
        <Wordmark/>
        <Tag>CONSOLE</Tag>
        <div style={{marginLeft:'auto',display:'flex'}}>
          <SyncChip status="ok" label="Discord ok"/>
          <SyncChip status="stale" label="GCal 4m ago"/>
          <SyncChip status="off" label="Rowan"/>
        </div>
      </TopBar>

      <div style={{display:'flex',minHeight:0}}>
        <Sidebar>
          <SidebarSection label="Schedule"/>
          <NavItem label="What I'm scheduling" meta={window.unsettledIds().length}
            active={view.kind==='agenda'&&view.mode==='scheduling'} onClick={()=>goAgenda('scheduling')}/>
          <NavItem label="What's confirmed" meta={window.settledIds().length}
            active={view.kind==='agenda'&&view.mode==='confirmed'} onClick={()=>goAgenda('confirmed')}/>
          <NavItem label="Date polls" meta={1}
            active={view.kind==='poll'} onClick={()=>setView({kind:'poll'})}/>
          <SidebarSection label="Campaigns" count={window.ORREY.campaigns.length}/>
          {window.ORREY.campaigns.map(c=>(
            <NavItem key={c.id} color={c.color} label={c.name} meta={c.next}
              active={view.kind==='campaign'&&view.id===c.id}
              onClick={()=>setView({kind:'campaign',id:c.id})}/>
          ))}
          <SidebarSection label="Manage"/>
          <NavItem label="Players" meta={window.ORREY.people.length}
            active={view.kind==='players'} onClick={()=>setView({kind:'players'})}/>
          <NavItem label="Games" meta={9}/>
          <NavItem label="Jobs" meta={3}/>
          <NavItem label="Settings"/>
        </Sidebar>

        {view.kind==='agenda'&&<Agenda mode={view.mode} grouped={grouped} setGrouped={setGrouped}
          filter={filter} setFilter={setFilter} selected={sel} onSelect={setSel}/>}
        {view.kind==='campaign'&&<CampaignPage campaign={window.ORREY.campaigns.find(c=>c.id===view.id)}/>}
        {view.kind==='players'&&<PlayersPage/>}
        {view.kind==='poll'&&<PollPage/>}

        {view.kind==='agenda'&&<DetailRail item={item}/>}
      </div>

      <StatusBar>
        <StatusItem label="DB" value="authoritative"/>
        <StatusItem label="Open polls" value={1}/>
        <StatusItem label="Jobs pending" value={3}/>
        <StatusItem label="Next drain" value="00:15"/>
        <StatusItem label="Horizon" value="2 per campaign"/>
      </StatusBar>
    </div>
  );
}
ReactDOM.createRoot(document.getElementById('root')).render(<ConsoleApp/>);
