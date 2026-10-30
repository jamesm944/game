#!/usr/bin/env python3
import json, math, pathlib, statistics
ROOT=pathlib.Path(__file__).parent
RES=ROOT/'results'
def pct(values,p):
    if not values:return None
    values=sorted(values); return values[max(0,math.ceil(len(values)*p)-1)]
def dist(values):
    values=[v for v in values if v is not None]
    return {'n':len(values),'p50':pct(values,.5),'p95':pct(values,.95),'max':max(values) if values else None,
            'mean':statistics.fmean(values) if values else None}
def load(policy,i):
    with open(RES/f'chrome-{policy}-iteration-{i}.json') as f:return json.load(f)
runs={(p,i):load(p,i) for p in ('fifo','batch-32') for i in range(1,6) if (RES/f'chrome-{p}-iteration-{i}.json').exists()}
summary={}; pooled={}
for (policy,i),raw in runs.items():
    r=raw['measured']; requests=r['requests']; frames=r['frames']; protocol=r['protocol']['responses']
    response_by_id={x['id']:x for x in protocol}
    leaders=[x for x in requests if x.get('requestClass')=='leader']
    repaths=[x for x in requests if x.get('requestClass')=='repath']
    apply=[x['applyCostMs'] for x in requests if x.get('applyCostMs') is not None]
    def cls(rows,key):return dist([x.get(key) for x in rows])
    def telemetry(rows,key):return dist([response_by_id[x['id']][key] for x in rows if x['id'] in response_by_id])
    row={'policy':policy,'iteration':i,'wallClockMs':r['wallClockMs'],'frameCount':r['frameCount'],
         'leaderResponse':cls(leaders,'responseMs'),'repathResponse':cls(repaths,'responseMs'),
         'leaderQueue':telemetry(leaders,'workerQueueMs'),'repathQueue':telemetry(repaths,'workerQueueMs'),
         'leaderCompute':telemetry(leaders,'computeMs'),'repathCompute':telemetry(repaths,'computeMs'),
         'frameInterval':dist([x['frameIntervalMs'] for x in frames[1:]]),
         'renderCpu':dist([x['renderCpuMs'] for x in frames]),'simulationCpu':dist([x['simulationCpuMs'] for x in frames]),
         'applyCpu':dist(apply),'blockedFrames':sum(x['blockedAttempts']>0 for x in frames),
         'blockedAttempts':sum(x['blockedAttempts'] for x in frames),'blockedTicks':r['scheduler']['blockedTicks'],
         'drawCalls':dist([x['drawCalls'] for x in frames]),'triangles':dist([x['triangles'] for x in frames]),
         'requestMessages':r['candidateMetrics']['requestMessages'],'resultMessages':r['candidateMetrics']['resultMessages'],
         'fullSnapshotBytes':r['candidateMetrics']['fullSnapshotBytes'],'deltaSnapshotBytes':r['candidateMetrics']['deltaSnapshotBytes'],
         'responseWaypointBytes':r['candidateMetrics']['responseWaypointBytes'],
         'eligible':r['candidateMetrics']['coalescingEligibleResponses'],'coalesced':r['candidateMetrics']['coalescedResponses'],
         'outcomes':r['outcomeCounts'],'requests':len(requests),'leaders':len(leaders),'repaths':len(repaths),
         'finalHash':r['finalFullStateHash'],'combat':r['combat'],'workload':r['workload']}
    summary[f'{policy}-{i}']=row
for policy in ('fifo','batch-32'):
    selected=[raw['measured'] for (p,i),raw in runs.items() if p==policy]
    if not selected:continue
    reqs=[x for r in selected for x in r['requests']]
    resp=[x for r in selected for x in r['protocol']['responses']]
    byid={x['id']:x for x in resp}
    leaders=[x for x in reqs if x.get('requestClass')=='leader']; repaths=[x for x in reqs if x.get('requestClass')=='repath']
    frames=[x for r in selected for x in r['frames']]
    pooled[policy]={'samples':len(selected),'leaderResponse':dist([x.get('responseMs') for x in leaders]),
      'repathResponse':dist([x.get('responseMs') for x in repaths]),
      'leaderQueue':dist([byid[x['id']]['workerQueueMs'] for x in leaders if x['id'] in byid]),
      'repathQueue':dist([byid[x['id']]['workerQueueMs'] for x in repaths if x['id'] in byid]),
      'leaderCompute':dist([byid[x['id']]['computeMs'] for x in leaders if x['id'] in byid]),
      'repathCompute':dist([byid[x['id']]['computeMs'] for x in repaths if x['id'] in byid]),
      'frameInterval':dist([x['frameIntervalMs'] for r in selected for x in r['frames'][1:]]),
      'renderCpu':dist([x['renderCpuMs'] for x in frames]),
      'wallClockMs':dist([r['wallClockMs'] for r in selected]),
      'blockedFrames':sum(x['blockedAttempts']>0 for x in frames),'blockedTicks':sum(r['scheduler']['blockedTicks'] for r in selected)}
comparisons=[]
for i in sorted({i for p,i in runs}):
    if ('fifo',i) not in runs or ('batch-32',i) not in runs:continue
    a=summary[f'fifo-{i}'];b=summary[f'batch-32-{i}']
    comparisons.append({'iteration':i,'leaderP95DeltaMs':b['leaderResponse']['p95']-a['leaderResponse']['p95'],
      'repathP95DeltaMs':b['repathResponse']['p95']-a['repathResponse']['p95'],
      'repathP50DeltaMs':b['repathResponse']['p50']-a['repathResponse']['p50'],
      'blockedFrameDelta':b['blockedFrames']-a['blockedFrames'],'wallDeltaMs':b['wallClockMs']-a['wallClockMs']})
node={}
for policy,name in (('fifo','node-fifo-delayed-full.json'),('batch-32','node-batch32-delayed-full.json')):
    with open(RES/name) as f:node[policy]=json.load(f)
replay=[]
for (policy,i),raw in runs.items():
    r=raw['measured'];n=node[policy]
    replay.append({'policy':policy,'iteration':i,'finalHashMatchesNode':r['finalFullStateHash']==n['finalFullStateHash'],
      'milestonesMatchNode':r['milestones']==n['milestones'],'outcomesMatchNode':r['outcomes']==n['outcomes'],
      'outcomeCountsMatchNode':r['outcomeCounts']==n['outcomeCounts'],
      'issueApplyTwoForRecorded':all(x.get('issueToApplyTicks')==2 for x in r['requests'] if x.get('applyTick') is not None),
      'requestCountMatchesNode':len(r['requests'])==len(n['requests']),
      'finalQueueDepth':r['scheduler']['finalQueueDepth']})
output={'schema':'wayfinder-172-dense-analysis-v1','sampleCounts':{p:sum(1 for x,i in runs if x==p) for p in ('fifo','batch-32')},
        'perIteration':summary,'pooled':pooled,'comparisons':comparisons,'replay':replay,
        'node':{p:{'finalHash':r['finalFullStateHash'],'outcomes':r['outcomeCounts'],'requests':len(r['requests']),
                   'messages':r['candidateMetrics']['requestMessages']} for p,r in node.items()},
        'notes':['Render CPU is main-thread render preparation plus WebGL submission, not GPU time.',
                 'Worker queue crosses agent clocks; raw negative values are not clamped.',
                 'Only completed raw samples are analyzed; no killed-attempt metrics are included.']}
with open(RES/'analysis.json','w') as f:json.dump(output,f,indent=2);f.write('\n')
print(json.dumps({'sampleCounts':output['sampleCounts'],'comparisons':comparisons,'pooled':pooled,'replay':replay},indent=2))
