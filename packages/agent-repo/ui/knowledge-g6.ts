// G6 5.1.1 ships a preset-free ESM entry. Register only the primitives used by
// this viewer; importing the default preset also installs unrelated algorithms,
// 3D behaviors and chart plugins into every management page.
export {Graph,CircleCombo,ExtensionCategory,register,getExtension} from '@antv/g6/esm/exports';
export type {CircleComboStyleProps} from '@antv/g6';
import {Circle,Line,DragCanvas,ZoomCanvas,OptimizeViewportTransform,register,ExtensionCategory,getExtension} from '@antv/g6/esm/exports';
import {ArrangeDrawOrder,CollapseExpandCombo,CollapseExpandNode,GetEdgeActualEnds,UpdateRelatedEdge} from '@antv/g6/esm/transforms';
import {light} from '@antv/g6/esm/themes';
if(!getExtension(ExtensionCategory.NODE,'circle')){
 register(ExtensionCategory.NODE,'circle',Circle);register(ExtensionCategory.EDGE,'line',Line);
 register(ExtensionCategory.BEHAVIOR,'drag-canvas',DragCanvas);register(ExtensionCategory.BEHAVIOR,'zoom-canvas',ZoomCanvas);
 register(ExtensionCategory.THEME,'light',light);register(ExtensionCategory.BEHAVIOR,'optimize-viewport-transform',OptimizeViewportTransform);
 register(ExtensionCategory.TRANSFORM,'arrange-draw-order',ArrangeDrawOrder);
 register(ExtensionCategory.TRANSFORM,'collapse-expand-combo',CollapseExpandCombo);
 register(ExtensionCategory.TRANSFORM,'collapse-expand-node',CollapseExpandNode);
 register(ExtensionCategory.TRANSFORM,'get-edge-actual-ends',GetEdgeActualEnds);
 register(ExtensionCategory.TRANSFORM,'update-related-edges',UpdateRelatedEdge);
}
