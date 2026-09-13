const {Wordmark,Button,Panel,Field,Input,Select,Checkbox,Pill,Tag,SyncChip,StatusBar,StatusItem,DataTable,Cell}=window.OrreyDesignSystem_4c8cbd;

function Shell({children,wide}){
  return (
    <div style={{minHeight:'100vh',display:'grid',placeItems:'center',padding:'var(--space-10)'}}>
      <div style={{width:wide?720:420,maxWidth:'100%'}}>{children}</div>
    </div>
  );
}

function Login(){
  return (
    <Shell>
      <div style={{display:'flex',flexDirection:'column',gap:'var(--space-9)'}}>
        <Wordmark size={22}/>
        <div>
          <h1 style={{font:'var(--type-heading)',margin:'0 0 var(--space-4)'}}>Sign in</h1>
          <p style={{font:'var(--type-small)',color:'var(--text-secondary)',margin:0,maxWidth:'44ch'}}>
            Discord is the only identity system. Orrey asks for <code style={{font:'var(--type-log)',
            color:'var(--text-primary)'}}>identify</code> and nothing else — your roles are read with
            the bot token, and the list of servers you are in is never requested.
          </p>
        </div>
        <button style={{height:'var(--control-lg)',display:'flex',alignItems:'center',
          justifyContent:'center',gap:10,background:'var(--discord-blurple)',color:'#fff',
          border:0,borderRadius:'var(--radius-none)',fontFamily:'var(--font-ui)',fontWeight:500,
          fontSize:14,cursor:'pointer'}}>Continue with Discord</button>
        <div style={{borderTop:'1px solid var(--line-hair)',paddingTop:'var(--space-6)',
          display:'flex',gap:'var(--space-7)'}}>
          <a href="#" style={{font:'var(--type-small)'}}>Privacy</a>
          <a href="#" style={{font:'var(--type-small)'}}>Delete my data</a>
          <span style={{marginLeft:'auto',font:'var(--type-log)',color:'var(--text-muted)'}}>phase 2</span>
        </div>
      </div>
    </Shell>
  );
}

function FirstRun(){
  const rows=[
    ['Guild','the Orrey of Worlds','ok'],
    ['Scheduling channel','#session-planning','ok'],
    ['Campaign roles','4 adopted from Hermuz','ok'],
    ['Campaign channels','4 adopted from Hermuz','ok'],
    ['Live scheduled events','7 adopted','ok'],
    ['Orrey calendar','service account granted writer','pending']
  ];
  return (
    <Shell wide>
      <div style={{display:'flex',alignItems:'center',gap:'var(--space-6)',marginBottom:'var(--space-8)'}}>
        <Wordmark size={16}/><Tag>FIRST RUN</Tag>
        <span style={{marginLeft:'auto',font:'var(--type-log)',color:'var(--text-muted)'}}>step 2 of 3</span>
      </div>
      <Panel title="Adopted Discord ids" meta="no data is imported" flush>
        <DataTable columns={[{label:'Object',width:200},{label:'Value'},{label:'State',width:120}]}>
          {rows.map(([k,v,s])=>(
            <tr key={k} style={{borderBottom:'1px solid var(--line-hair)'}}>
              <Cell style={{font:'var(--type-body-medium)'}}>{k}</Cell>
              <Cell style={{font:'var(--type-log)',color:'var(--text-secondary)'}}>{v}</Cell>
              <Cell><Pill tone={s==='ok'?'in':'maybe'}>{s==='ok'?'adopted':'pending'}</Pill></Cell>
            </tr>
          ))}
        </DataTable>
      </Panel>
      <div style={{marginTop:'var(--space-8)'}}>
        <Panel title="Enter a campaign" meta="four, by hand">
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:'var(--space-6)'}}>
            <Field label="Name"><Input defaultValue="Age of Umbra"/></Field>
            <Field label="Kind"><Select options={['Run','Play','Tracked']}/></Field>
            <Field label="First session number" hint="History starts empty."><Input defaultValue="14"/></Field>
            <Field label="Anchor date"><Input defaultValue="2025-02-06"/></Field>
            <Field label="Interval (weeks)"><Input defaultValue="1"/></Field>
            <Field label="Quorum"><Input defaultValue="4"/></Field>
          </div>
          <div style={{display:'flex',gap:'var(--space-4)',marginTop:'var(--space-7)',alignItems:'center'}}>
            <Checkbox checked label="Point at the adopted role and channel"/>
            <Button variant="primary" style={{marginLeft:'auto'}}>Save campaign 1 of 4</Button>
          </div>
        </Panel>
      </div>
      <p style={{font:'var(--type-small)',color:'var(--text-muted)',marginTop:'var(--space-7)'}}>
        Session numbers need seeding and history starts empty, so flake memory says nothing for
        a couple of months. Both are known costs of a fresh database.
      </p>
    </Shell>
  );
}

function CalendarView(){
  const days=['Mon 29','Tue 30','Wed 01','Thu 02','Fri 03','Sat 04','Sun 05'];
  const events=[
    {day:3,start:19.5,end:23,label:'Age of Umbra · S14',color:'var(--campaign-1)'},
    {day:6,start:14,end:18,label:'The Salt Road · S07',color:'var(--campaign-2)'},
    {day:1,start:20,end:23,label:'Hollowmere · S01',color:'var(--campaign-3)'}
  ];
  const H=18,START=12;
  return (
    <div style={{padding:'var(--space-9)',minHeight:'100vh'}}>
      <div style={{display:'flex',alignItems:'center',gap:'var(--space-6)',marginBottom:'var(--space-7)'}}>
        <h1 style={{font:'var(--type-title)',margin:0}}>Orrey calendar</h1>
        <Pill tone="idle">projection</Pill>
        <Tag>ics feed · per campaign</Tag>
        <span style={{marginLeft:'auto',font:'var(--type-small)',color:'var(--text-muted)'}}>
          Orrey writes here and nowhere else. Your Social calendar is never touched.</span>
      </div>
      <div style={{border:'1px solid var(--line-structural)',background:'var(--surface-chrome)'}}>
        <div style={{display:'grid',gridTemplateColumns:'56px repeat(7,1fr)',
          borderBottom:'1px solid var(--line-structural)'}}>
          <div/>
          {days.map(d=>(
            <div key={d} style={{padding:'var(--space-5) var(--space-4)',font:'var(--type-micro)',
              letterSpacing:'var(--tracking-label)',textTransform:'uppercase',color:'var(--text-muted)',
              borderLeft:'1px solid var(--line-hair)'}}>{d}</div>
          ))}
        </div>
        <div style={{display:'grid',gridTemplateColumns:'56px repeat(7,1fr)',position:'relative',height:11*32}}>
          <div>
            {Array.from({length:11},(_,i)=>(
              <div key={i} style={{height:32,font:'var(--type-log)',lineHeight:'32px',
                color:'var(--text-muted)',textAlign:'right',paddingRight:8,
                borderBottom:'1px solid var(--line-hair)'}}>{String(START+i).padStart(2,'0')}</div>
            ))}
          </div>
          {days.map((d,di)=>(
            <div key={d} style={{position:'relative',borderLeft:'1px solid var(--line-hair)'}}>
              {Array.from({length:11},(_,i)=>(
                <div key={i} style={{height:32,borderBottom:'1px solid var(--line-hair)'}}/>
              ))}
              {events.filter(e=>e.day===di).map(e=>(
                <div key={e.label} style={{position:'absolute',left:2,right:2,
                  top:(e.start-START)*32,height:(e.end-e.start)*32,
                  background:'var(--surface-raised)',borderLeft:'3px solid '+e.color,
                  padding:'6px 8px',overflow:'hidden'}}>
                  <div style={{font:'var(--type-data)',color:'var(--text-primary)'}}>
                    {String(Math.floor(e.start)).padStart(2,'0')}:{e.start%1?'30':'00'}</div>
                  <div style={{font:'var(--type-small)',color:'var(--text-secondary)',marginTop:2}}>{e.label}</div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'var(--space-8)',marginTop:'var(--space-8)'}}>
        <Panel title="Event detail">
          <div style={{display:'grid',gap:'var(--space-4)'}}>
            <span style={{font:'var(--type-heading)'}}>Age of Umbra · S14</span>
            <span style={{font:'var(--type-log)',color:'var(--text-secondary)'}}>thu 02 oct · 19:30 — 23:00 · the foundry</span>
            <div style={{display:'flex',gap:'var(--space-3)',marginTop:'var(--space-3)',flexWrap:'wrap'}}>
              <Tag>orr_5f2a</Tag><Tag>fingerprint 8c1d</Tag><Pill tone="in">synced</Pill>
            </div>
            <p style={{font:'var(--type-small)',color:'var(--text-muted)',margin:'var(--space-4) 0 0'}}>
              Ids are minted by Orrey in base32hex: insert, and on 409, update. The fingerprint is
              what stops the return path echoing.</p>
          </div>
        </Panel>
        <Panel title="Attendees">
          <p style={{font:'var(--type-small)',color:'var(--text-secondary)',margin:0}}>
            Orrey does not RSVP on anyone's behalf. Google's <code style={{font:'var(--type-log)'}}>responseStatus</code> is
            left alone; the authoritative answer is in Orrey and shown in Discord.
          </p>
        </Panel>
      </div>
    </div>
  );
}

Object.assign(window,{Login,FirstRun,CalendarView});
