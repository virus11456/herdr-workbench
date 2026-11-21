const footerPatterns={
 codex:/^\s*(GPT-[A-Za-z0-9.-]+)\s+(?:minimal|low|medium|high|xhigh|max)\s*[·|]/i,
 antigravity:/(?:^|\s{2,})(?:auto|plan|accept[- ]edits)\s*·\s*((?:Gemini|Claude|GPT)[ A-Za-z0-9_.-]{1,65}?)\s*·\s*(?:low|medium|high|xhigh|max)\s*$/i,
 minimax:/\b((?:MiniMax[- ]?)?M[23](?:\.\d+)?(?:-[A-Za-z0-9]+)*)\s*·\s*Effort\s+[A-Za-z][\w-]*\s*│\s*Context\s+[\d.]+[KMB%]?\s*$/i
};
const apps={'claude-code':'claude',claude:'claude',codex:'codex',antigravity:'antigravity',minimax:'minimax',mcode:'minimax'};
export const terminalProvider=t=>Object.hasOwn(apps,t?.status?.app)?apps[t.status.app]:null;
export const validModel=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9 +._:/()-]{0,95}$/.test(value);
export function footerModel(provider,text){
 const scan=typeof text==='string'?text.trimEnd().split('\n').slice(-3):[];
 if(provider==='codex')return scan.findLast(line=>footerPatterns.codex.test(line))?.match(footerPatterns.codex)?.[1]||null;
 return scan.at(-1)?.match(footerPatterns[provider]||/$^/)?.[1]?.trim()||null;
}

export function mergeModel(models,agentId,provider,model,at){
 if(!validModel(model)||!Number.isSafeInteger(at)||at<=0)return false;
 const previous=models[agentId];
 if(previous&&previous.at>=at)return false;
 models[agentId]={model,provider,at};
 return true;
}
