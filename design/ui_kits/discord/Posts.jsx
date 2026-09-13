const {DiscordMessage,DiscordEmbed,DiscordButtonRow,DiscordSelect,EphemeralNote}=window.OrreyDesignSystem_4c8cbd;

function names(list){return list.length?list.join(', '):'—';}

function AttendancePost({state,onVote,onRefresh}){
  const inList=state.roster.filter(r=>r.intent==='in').map(r=>r.name);
  const outList=state.roster.filter(r=>r.intent==='out').map(r=>r.name);
  const silent=state.roster.filter(r=>r.intent==='silent').map(r=>r.name);
  const maybe=state.roster.filter(r=>r.intent==='maybe').map(r=>r.name);
  const met=inList.length>=state.quorum;
  return (
    <DiscordMessage timestamp="Today at 17:00">
      <DiscordEmbed color="var(--campaign-1)"
        title="Age of Umbra · Session 14"
        description={"Thursday 2 October, 19:30 — 23:00\nThe Foundry · GM Rowan"}
        fields={[
          {name:'In ('+inList.length+')',value:names(inList)},
          {name:'Out ('+outList.length+')',value:names(outList)},
          {name:'No reply ('+silent.length+')',value:names(silent)},
          ...(maybe.length?[{name:'Maybe ('+maybe.length+')',value:names(maybe),inline:false}]:[])
        ]}
        footer={met?'Quorum met — this one runs':'Needs '+(state.quorum-inList.length)+' more to run'}
        asOf={'as of '+state.asOf}/>
      <DiscordButtonRow buttons={[
        {label:'In',style:'success',count:inList.length,onClick:()=>onVote('in')},
        {label:'Out',style:'danger',count:outList.length,onClick:()=>onVote('out')},
        {label:'Maybe',style:'secondary',onClick:()=>onVote('maybe')},
        {label:'Note',style:'secondary'}]}/>
      <DiscordButtonRow buttons={[
        {label:'Suggest another day',style:'secondary'},
        {label:'Refresh',style:'secondary',onClick:onRefresh}]}/>
    </DiscordMessage>
  );
}

function SignupPost(){
  return (
    <DiscordMessage timestamp="Yesterday at 11:20">
      <DiscordEmbed color="var(--campaign-5)"
        title="Game day · Twilight Imperium"
        description={"Saturday 11 October, 12:00\nThe Foundry · hosted by Rowan · 6 seats"}
        fields={[
          {name:'Seated (6)',value:'Rowan, Tam, Jodie, Priya, Dev, Marco'},
          {name:'Waitlist (2)',value:'Elle, Sam'},
          {name:'Out (1)',value:'Kit'}
        ]}
        footer="Full — waitlist promotes automatically" asOf="as of 18:44"/>
      <DiscordButtonRow buttons={[
        {label:'Take a seat',style:'success',disabled:true},
        {label:'Waitlist',style:'primary'},
        {label:'Out',style:'danger'},
        {label:"Can't make this one — suggest a day",style:'secondary'}]}/>
    </DiscordMessage>
  );
}

function PollPost({picked,onToggle}){
  return (
    <DiscordMessage timestamp="Today at 20:14">
      <DiscordEmbed color="var(--campaign-2)"
        title="Which Saturdays work?"
        description={"Pre-signup poll · winning dates become game days.\nOne poll may produce several."}
        fields={[
          {name:'Sat 04 Oct',value:'3 · Rowan, Tam, Dev'},
          {name:'Sat 11 Oct',value:'6 · full table'},
          {name:'Sat 18 Oct',value:'2 · Jodie, Elle'}
        ]}
        footer="Closes Fri 10 Oct, 18:00 · threshold 4" asOf="as of 20:14"/>
      <DiscordSelect open placeholder="Which days can you make?" selected={picked} onToggle={onToggle}
        options={[{label:'Sat 04 Oct',count:3},{label:'Sat 11 Oct',count:6},
          {label:'Sat 18 Oct',count:2},{label:'Sun 19 Oct',count:4},{label:'Sat 25 Oct',count:1}]}/>
      <DiscordButtonRow buttons={[
        {label:'Canonise',style:'primary'},{label:'Refresh',style:'secondary'}]}/>
      <div style={{marginTop:6,fontSize:12,color:'var(--discord-muted)'}}>Canonise is organiser-only.</div>
    </DiscordMessage>
  );
}

function JeopardyNotice(){
  return (
    <DiscordMessage timestamp="Today at 19:30">
      <DiscordEmbed color="var(--state-maybe)"
        title="The Salt Road · S07 is short"
        description={"Sunday 5 October, 14:00 — 2 in, needs 5.\nThis is a new notice, not an edit: the post above is a snapshot and stays one."}
        footer="Jeopardy check, T-24h" asOf="as of 19:30"/>
      <DiscordButtonRow buttons={[
        {label:'In',style:'success'},{label:'Out',style:'danger'},
        {label:'Suggest another day',style:'secondary'}]}/>
    </DiscordMessage>
  );
}

function UpcomingReply(){
  return (
    <DiscordMessage author="Orrey" timestamp="Today at 20:31">
      <EphemeralNote>
        <DiscordEmbed color="var(--signal-500)"
          title="Upcoming — for you"
          description={"Everything you are on the roster for, right now. Always current; this is why there is no pinned board."}
          fields={[
            {name:'Thu 02 Oct, 19:30',value:'Age of Umbra · S14 — you are **in**',inline:false},
            {name:'Sun 05 Oct, 14:00',value:'The Salt Road · S07 — **no reply**, needs 3 more',inline:false},
            {name:'Sat 11 Oct, 12:00',value:'Twilight Imperium — **seated**',inline:false}
          ]}
          asOf="as of 20:31"/>
      </EphemeralNote>
    </DiscordMessage>
  );
}

function RetiredPost(){
  return (
    <DiscordMessage author="Orrey" timestamp="Today at 20:33">
      <EphemeralNote>
        <div style={{fontSize:15,color:'var(--discord-text)',marginTop:6}}>
          This post is retired — its buttons no longer do anything. Try <code style={{background:'#1e1f22',
          padding:'2px 5px',borderRadius:3,fontFamily:'var(--font-mono)',fontSize:13}}>/upcoming</code>.
        </div>
      </EphemeralNote>
    </DiscordMessage>
  );
}

Object.assign(window,{AttendancePost,SignupPost,PollPost,JeopardyNotice,UpcomingReply,RetiredPost});
