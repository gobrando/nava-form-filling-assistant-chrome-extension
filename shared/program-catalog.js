(function installProgramCatalog(root) {
  'use strict';

  const PROGRAMS = [
    {
      id: 'calfresh',
      name: 'CalFresh',
      provider: 'BenefitsCal',
      workflowId: 'benefitscal',
      url: 'https://benefitscal.com/ApplyForBenefits/begin/ABOVR?lang=en',
      allowedOrigins: ['https://benefitscal.com'],
      allowedPathPrefixes: ['/ApplyForBenefits/'],
    },
    {
      id: 'medical',
      name: 'Medi-Cal',
      provider: 'BenefitsCal',
      workflowId: 'benefitscal',
      url: 'https://benefitscal.com/ApplyForBenefits/begin/ABOVR?lang=en',
      allowedOrigins: ['https://benefitscal.com'],
      allowedPathPrefixes: ['/ApplyForBenefits/'],
    },
    {
      id: 'wic',
      name: 'WIC',
      provider: 'Riverside University Health System',
      workflowId: 'riverside-wic',
      url: 'https://www.ruhealth.org/appointments/apply-4-wic-form',
      allowedOrigins: ['https://www.ruhealth.org', 'https://ruhealth.org'],
      allowedPathPrefixes: ['/appointments/apply-4-wic-form'],
    },
    {
      id: 'calworks',
      name: 'CalWORKs',
      provider: 'BenefitsCal',
      workflowId: 'benefitscal',
      url: 'https://benefitscal.com/ApplyForBenefits/begin/ABOVR?lang=en',
      allowedOrigins: ['https://benefitscal.com'],
      allowedPathPrefixes: ['/ApplyForBenefits/'],
    },
    {
      id: 'ihss',
      name: 'IHSS',
      provider: 'Riverside County',
      workflowId: 'riverside-ihss',
      url: 'https://riversideihss.org/IntakeApp',
      allowedOrigins: ['https://riversideihss.org'],
      allowedPathPrefixes: ['/IntakeApp'],
    },
  ];

  function programDefinition(id) {
    return PROGRAMS.find((program) => program.id === id) || null;
  }

  function joinedNames(programs) {
    const names = programs.map((program) => program.name);
    if (names.length < 2) return names[0] || 'Application';
    if (names.length === 2) return `${names[0]} and ${names[1]}`;
    return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`;
  }

  function planWorkflows(selectedIds) {
    const groups = new Map();
    [...new Set(Array.isArray(selectedIds) ? selectedIds : [])]
      .map(programDefinition)
      .filter(Boolean)
      .forEach((program) => {
        const group = groups.get(program.workflowId) || [];
        group.push(program);
        groups.set(program.workflowId, group);
      });

    return [...groups.entries()].map(([workflowId, programs]) => ({
      workflowId,
      programIds: programs.map((program) => program.id),
      name: workflowId === 'benefitscal' && programs.length > 1
        ? `BenefitsCal — ${joinedNames(programs)}`
        : programs[0].name,
      provider: programs[0].provider,
      url: programs[0].url,
      allowedOrigins: [...new Set(programs.flatMap((program) => program.allowedOrigins || []))],
      allowedPathPrefixes: [...new Set(programs.flatMap((program) => program.allowedPathPrefixes || []))],
    }));
  }

  const api = { PROGRAMS, planWorkflows, programDefinition };
  root.NavaProgramCatalog = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
