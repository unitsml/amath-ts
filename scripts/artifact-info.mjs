import { initialize, SOURCE_COMMIT, modelJson } from '../dist/index.js';
const parser = await initialize();
console.log(JSON.stringify({sourceCommit:SOURCE_COMMIT,capabilities:parser.capabilities,shape:parser.parseShape('x^2'),tree:parser.parseTree('x^2'),bindings:parser.parseBindings('x^2'),typed:modelJson.CODECS['Amath::Model::Document@default'].encode(parser.parse('alpha'))},null,2));
