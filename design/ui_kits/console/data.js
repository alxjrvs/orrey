window.ORREY = {
  campaigns: [
    {id:'umbra', name:'Age of Umbra', color:'var(--campaign-1)', state:'RUNNING', quorum:4, roster:6,
     cadence:'Thursdays, every week', next:'2d', channel:'#age-of-umbra', gm:'Rowan', sessions:14},
    {id:'salt', name:'The Salt Road', color:'var(--campaign-2)', state:'RUNNING', quorum:5, roster:5,
     cadence:'Sundays, every 2 weeks', next:'5d', channel:'#the-salt-road', gm:'Priya', sessions:7},
    {id:'hollow', name:'Hollowmere', color:'var(--campaign-3)', state:'FORMING', quorum:4, roster:5,
     cadence:'Tuesdays, every 2 weeks', next:'9d', channel:'#hollowmere', gm:'Dev', sessions:0},
    {id:'ivy', name:'Iron & Ivy', color:'var(--campaign-idle)', state:'HIATUS', quorum:4, roster:4,
     cadence:'Paused', next:'—', channel:'#iron-and-ivy', gm:'Jodie', sessions:31}
  ],
  people: [
    {id:'rowan', name:'Rowan', initials:'RW', dm:'open', flake:0.04, on:['umbra','salt']},
    {id:'tam', name:'Tam', initials:'TK', dm:'open', flake:0.11, on:['umbra','salt']},
    {id:'jodie', name:'Jodie', initials:'JD', dm:'closed', flake:0.02, on:['umbra','hollow']},
    {id:'priya', name:'Priya', initials:'PS', dm:'open', flake:0.00, on:['umbra','salt']},
    {id:'marco', name:'Marco', initials:'MC', dm:'open', flake:0.23, on:['umbra','hollow']},
    {id:'elle', name:'Elle', initials:'EL', dm:'unknown', flake:0.09, on:['umbra','hollow']},
    {id:'dev', name:'Dev', initials:'DV', dm:'open', flake:0.05, on:['salt','hollow']}
  ],
  agenda: [
    {id:'s14', day:'Thu 02 October', rel:'in 2 days', when:'THU 02', time:'19:30',
     campaign:'umbra', title:'Age of Umbra · S14', sub:'the gate under callow hill',
     kind:'campaign_session', state:'confirmed', venue:'The Foundry',
     roster:[['rowan','in','GM'],['tam','in'],['jodie','in'],['priya','in'],['marco','out','','work'],['elle','silent']]},
    {id:'s07', day:'Sun 05 October', rel:'in 5 days', when:'SUN 05', time:'14:00',
     campaign:'salt', title:'The Salt Road · S07', sub:'caravan to meret',
     kind:'campaign_session', state:'jeopardy', venue:'Voice · The Long Table',
     roster:[['priya','in','GM'],['tam','in'],['dev','maybe'],['rowan','silent'],['jodie','silent']]},
    {id:'s22', day:'Tue 07 October', rel:'in 7 days', when:'TUE 07', time:'20:00',
     campaign:'hollow', title:'Hollowmere · S01', sub:'session zero',
     kind:'campaign_session', state:'confirmed', venue:'Voice · Hollowmere',
     roster:[['dev','in','GM'],['elle','in'],['jodie','in'],['marco','in'],['priya','in']]},
    {id:'s15', day:'Thu 09 October', rel:'in 9 days', when:'THU 09', time:'19:30',
     campaign:'umbra', title:'Age of Umbra · S15', sub:'—',
     kind:'campaign_session', state:'open', venue:'The Foundry',
     roster:[['rowan','in','GM'],['tam','silent'],['jodie','silent'],['priya','silent'],['marco','silent'],['elle','silent']]},
    {id:'gd1', day:'Sat 11 October', rel:'in 11 days', when:'SAT 11', time:'12:00',
     campaign:null, title:'Game day · Twilight Imperium', sub:'single · capacity 6 · signups close fri 18:00',
     kind:'game_day', state:'confirmed', venue:'The Foundry',
     roster:[['rowan','in','Host'],['tam','in'],['jodie','in'],['priya','in'],['dev','in'],['marco','in']]},
    {id:'s08', day:'Sun 12 October', rel:'in 12 days', when:'SUN 12', time:'14:00',
     campaign:'salt', title:'The Salt Road · S08', sub:'—',
     kind:'campaign_session', state:'unposted', venue:'Voice · The Long Table',
     roster:[['priya','silent','GM'],['tam','silent'],['dev','silent'],['rowan','silent'],['jodie','silent']]}
  ],
  log: [
    {at:'19:02', text:'gcal event orr_5f2a updated', tone:'write'},
    {at:'18:51', text:'priya → in via button'},
    {at:'18:44', text:'marco → out via button, note "work"'},
    {at:'18:31', text:'50007 dm blocked for jodie, fell back to channel mention', tone:'error'},
    {at:'17:00', text:'attendance post sent to #age-of-umbra', tone:'write'},
    {at:'16:00', text:'horizon materialised, 2 events per campaign'}
  ],
  poll: {
    target: null, kind:'multi', winRule:'Game minimum', threshold:4, closes:'Fri 10 Oct, 18:00',
    dates: [
      {date:'Sat 04 October', count:3, who:['Rowan','Tam','Dev']},
      {date:'Sat 11 October', count:6, who:['Rowan','Tam','Jodie','Priya','Dev','Marco'], winning:true},
      {date:'Sat 18 October', count:2, who:['Jodie','Elle']},
      {date:'Sun 19 October', count:4, who:['Rowan','Priya','Dev','Elle'], winning:true},
      {date:'Sat 25 October', count:1, who:['Marco']}
    ]
  }
};
