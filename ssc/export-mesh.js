#!/usr/bin/env node

var async = require('async');
var path = require('path');
var shell = require('shelljs');
var STK = require('./stk-ssc');
var cmd = require('./ssc-parseargs');
var THREE = global.THREE;
var _ = STK.util;

cmd
  .version('0.0.1')
  .description('Export asset as single mesh.  Tested with kmz to obj/mtl only.')
  .option('--input <filename>', 'Input path')
  .option('--input_format <format>', 'Input file format to use')
  .option('--input_type <type>', 'Input type (id or path)',  /^(id|path)$/, 'id')
  .option('--assetType <type>', 'Asset type (scene or model)', 'model')
  .option('--output_format <format>', 'Output file format to use', /^(obj|gltf)$/, 'obj')
  .option('--output_dir <dir>', 'Base directory for output files', '.')
  .optionGroups(['config_file', 'color_by'])
  .option('--skip_existing', 'Skip exporting of existing meshes [false]')
  .option('--compress', 'Compress output [false]')
  .option('--export_textures <type>',
    'How to export textures (`copy` will make copy of original textures, `export` will exporte jpn or png directly from the images with simple filenames)',
    /^(none|copy|export)$/, 'export')
  .option('--texture_path <dir>', 'Texture path for exported textures', 'images')
  .option('--center', 'Center so scene is at origin')
  .option('--normalize_size <flag>', 'What to normalize (diagonal or max dimension)', /^(diagonal|max)$/)
  .option('--normalize_size_to <target>', 'What to normalize the size to', STK.util.cmd.parseFloat, 1.0)
  .option('--auto_align [flag]', 'Whether to auto align asset', STK.util.cmd.parseBoolean, false)
  .option('--require_faces [flag]', 'Whether to skip geometry without faces when exporting', STK.util.cmd.parseBoolean, false)
  .option('--handle_material_side [flag]', 'Whether to duplicate or reverse face vertices when exporting based on double-sided or back-sided materials', STK.util.cmd.parseBoolean, false)
  .option('--use_search_controller [flag]', 'Whether to lookup asset information online', STK.util.cmd.parseBoolean, false)
  .option('--include_group [flag]', 'Whether to include group g commands in the output obj file', STK.util.cmd.parseBoolean, false)
  .parse(process.argv);

// Parse arguments and initialize globals
if (!cmd.input) {
  console.error('Please specify --input <filename>');
  process.exit(-1);
}
var files = [cmd.input];
if (cmd.input.endsWith('.txt')) {
  // Read files form input file
  var data = STK.util.readSync(cmd.input);
  files = data.split('\n').map(function(x) { return STK.util.trim(x); }).filter(function(x) { return x.length > 0; });
}

if (cmd.assetInfo && cmd.assetInfo.source) {
  var source = cmd.assetInfo.source;
  if (!cmd.assetGroups) { cmd.assetGroups = [source]; }
  if (cmd.assetGroups.indexOf(source) < 0) { cmd.assetGroups.push(source); }
}

if (cmd.assetGroups) {
  STK.assets.AssetGroups.registerDefaults();
  var assets = require('./data/assets.json');
  var assetsMap = _.keyBy(assets, 'name');
  STK.assets.registerCustomAssetGroupsSync(assetsMap, cmd.assetGroups);  // Make sure we get register necessary asset groups
}

var output_basename = cmd.output;
var useSearchController = cmd.use_search_controller;
var assetManager = new STK.assets.AssetManager({
  autoAlignModels: cmd.auto_align, autoScaleModels: false, assetCacheSize: 100,
  searchController: useSearchController? new STK.search.BasicSearchController() : null
});

var sceneDefaults = { includeCeiling: true, attachWallsToRooms: true };
if (cmd.scene) {
  sceneDefaults = _.merge(sceneDefaults, cmd.scene);
}
if (cmd.assetInfo) {
  sceneDefaults = _.defaults(sceneDefaults, cmd.assetInfo);
}

function rewriteTexturePath(src) {
  //console.log('Rewriting ' + src + ', replacing ' + texturePath);
  // src = src.replace(texturePath, '');
  // src = src.replace(/.*\/..\/..\/texture\//, '');
  // src = cmd.texture_path + '/' + src;
  return src;
}

function exportScene(exporter, exportOpts, sceneState, callback) {
  var scene = exportOpts.rootObject || sceneState.scene;
  var sceneId = sceneState.info.id;
  var filename = exportOpts.name || sceneId;
  exporter.export(scene, _.defaults({name: filename, callback: callback}, exportOpts));
}

//STK.Constants.setVirtualUnit(1);
var nodeNameFunc = function (node) {
  if (node.userData.type && node.userData.id != undefined) {
    return node.userData.type + '#' + node.userData.id;
  } else if (node.name) {
    return node.name;
  } else if (node.userData.id != undefined) {
    var type = node.type.toLowerCase();
    return type + '_' + node.userData.id;
  } else {
    var type = node.type.toLowerCase();
    return type + '_' + node.id;
  }
};

// TODO: Support different exporters
var objExporter;
if (cmd.output_format === 'obj') {
  objExporter = new STK.exporters.OBJMTLExporter({ fs: STK.fs });
} else if (cmd.output_format === 'gltf') {
  objExporter = new STK.exporters.GLTFExporter({ fs: STK.fs });
}

function processFiles() {
  async.forEachOfSeries(files, function (file, index, callback) {
    STK.util.clearCache();

    var outputDir = cmd.output_dir;
    var basename = output_basename;
    var scenename;
    if (basename) {
      // Specified output - append index
      if (files.length > 0) {
        basename = basename + '_' + index;
      }
      scenename = basename;
      basename = outputDir? outputDir + '/' + basename : basename;
    } else {
      if (cmd.input_type === 'id') {
        var idparts = file.split('.');
        var id = idparts[idparts.length-1];
        basename = id;
        scenename = basename;
        basename = (outputDir ? outputDir : '.') + '/' + basename;
      } else if (cmd.input_type === 'path') {
        basename = path.basename(file, path.extname(file)) || 'mesh';
        scenename = basename;
        basename = (outputDir ? outputDir : path.dirname(file)) + '/' + basename;
      }
    }

    if (cmd.skip_existing && shell.test('-d', basename)) {
      console.warn('Skipping existing scene at ' + basename);
      setTimeout(function () { callback(); }, 0);
    } else {
      var texturePath = cmd.texture_path;
      shell.mkdir('-p', basename);
      var info;
      var timings = new STK.Timings();
      timings.start('exportMesh');
      var metadata = {};
      if (cmd.input_type === 'id') {
        info = { fullId: file, format: cmd.input_format, assetType: cmd.assetType, defaultMaterialType: THREE.MeshPhongMaterial };
        metadata.id = id;
      } else if (cmd.input_type === 'path') {
        info = { file: file, format: cmd.input_format, assetType: cmd.assetType, defaultMaterialType: THREE.MeshPhongMaterial };
        metadata.path = file;
      }
      if (cmd.assetInfo) {
        info = _.defaults(info, cmd.assetInfo);
      }

      var exportTexturesFlag = false;
      if (cmd.export_textures === 'none') {
      } else if (cmd.export_textures === 'copy') {
        // TODO: This currently works just for ZipLoader
        // Make sure that this works for textures directly obtained from the internet
        info.options = {
          textureCacheOpts: {
            dir: basename, //+ '/' + texturePath,
            rewritePath: rewriteTexturePath,
            fs: STK.fs
          }
        };
      } else if (cmd.export_textures === 'export') {
        shell.mkdir('-p', basename + '/' + texturePath);
        exportTexturesFlag = true;
      }

      timings.start('load');
      assetManager.loadAsset(info, function (err, asset) {
        timings.stop('load');
        var sceneState;
        var rootObject;
        if (asset instanceof STK.scene.SceneState) {
          sceneState = asset;
        } else if (asset instanceof STK.model.ModelInstance) {
          var modelInstance = asset;
          sceneState = new STK.scene.SceneState(null, modelInstance.model.info);
          timings.start('toGeometry');
          // Ensure is normal geometry (for some reason, BufferGeometry not working with ssc)
          STK.geo.Object3DUtil.traverseMeshes(modelInstance.object3D, false, function(m) {
            m.geometry = STK.geo.GeometryUtil.toGeometry(m.geometry);
          });
          timings.stop('toGeometry');
          sceneState.addObject(modelInstance, cmd.auto_align);
          // Hack to discard some nested layers of names for a model instance
          rootObject = modelInstance.getObject3D('Model').children[0];
        } else if (err) {
          console.error("Error loading asset", info, err);
          return;
        } else {
          console.error("Unsupported asset type ", info, asset);
          return;
        }

        sceneState.compactify();  // Make sure that there are no missing models
        sceneState.scene.name = scenename;
        var sceneBBox = STK.geo.Object3DUtil.getBoundingBox(sceneState.fullScene);
        var bbdims = sceneBBox.dimensions();
        console.log('Loaded ' + file +
          ' bbdims: [' + bbdims.x + ',' + bbdims.y + ',' + bbdims.z + ']');
        var bboxes = [];
        bboxes.push(sceneBBox.toJSON('loaded'));
        if (cmd.require_faces) {
          //STK.geo.Object3DUtil.removeLines(sceneState.scene);
          //STK.geo.Object3DUtil.removePoints(sceneState.scene);
          STK.geo.Object3DUtil.removeEmptyGeometries(sceneState.scene);
          STK.geo.Object3DUtil.clearCache(sceneState.fullScene);
          sceneBBox = STK.geo.Object3DUtil.getBoundingBox(sceneState.fullScene);
          bbdims = sceneBBox.dimensions();
          console.log('Removed empty geometry, lines, points ' + file +
            ' bbdims: [' + bbdims.x + ',' + bbdims.y + ',' + bbdims.z + ']');
          bboxes.push(sceneBBox.toJSON('cleaned'));
        }
        if (cmd.normalize_size) {
          STK.geo.Object3DUtil.rescaleObject3DToFit(sceneState.fullScene,
            { rescaleBy: cmd.normalize_size, rescaleTo: cmd.normalize_size_to });
          sceneBBox = STK.geo.Object3DUtil.getBoundingBox(sceneState.fullScene);
          bbdims = sceneBBox.dimensions();
          console.log('After rescaling ' + file +
            ' bbdims: [' + bbdims.x + ',' + bbdims.y + ',' + bbdims.z + ']', bbdims.length());
          bboxes.push(sceneBBox.toJSON('rescaled'));
        }
        if (cmd.center) {
          STK.geo.Object3DUtil.placeObject3D(sceneState.fullScene);
          console.log('Before centering ' + file, sceneBBox.toString());
          sceneBBox = STK.geo.Object3DUtil.getBoundingBox(sceneState.fullScene);
          bbdims = sceneBBox.dimensions();
          console.log('After centering ' + file, sceneBBox.toString());
          bboxes.push(sceneBBox.toJSON('centered'));
        }

        var unit = 1;
        var sceneTransformMatrixInverse = new THREE.Matrix4();
        if (!cmd.normalize_size && !cmd.center) {
          sceneTransformMatrixInverse.getInverse(sceneState.scene.matrixWorld);
          if (unit) {
            // Hack to put into meters
            var scaleMat = new THREE.Matrix4();
            scaleMat.makeScale(unit, unit, unit);
            sceneTransformMatrixInverse.multiply(scaleMat);
          }
        } else {
          metadata.transform = sceneState.scene.matrixWorld.toArray();
        }
        // Export scene
        var exportOpts = {
          dir: basename,
          name: scenename,
          rootObject: rootObject,
          skipMtl: false,
          exportTextures: exportTexturesFlag,
          handleMaterialSide: cmd.handle_material_side,
          texturePath: texturePath,
          rewriteTexturePathFn: rewriteTexturePath,
          transform: sceneTransformMatrixInverse,
          //defaultUvScale: new THREE.Vector2(0.01, 0.01),
          getMeshName: nodeNameFunc,
          getGroupName: cmd.include_group? function(node) {
            // Hack to discard some nested layers of names for a model instance
            if (node === rootObject) {
              return null;
            } else {
              return nodeNameFunc(node)
            }
          } : null
        };
        function waitImages() {
          STK.util.waitImagesLoaded(function () {
            timings.start('export');
            exportScene(objExporter, exportOpts, sceneState, function (err, result) {
              if (cmd.compress) {
                var objfile = basename + '/' + scenename + '.obj';
                //console.log('Compressing ' + objfile);
                STK.util.execSync('xz -f ' + objfile, {encoding: 'utf8'});
              }
              timings.stop('export');
              timings.stop('exportMesh');
              // Output metadata
              metadata['bbox'] = sceneBBox.toJSON();
              metadata['bboxes'] = bboxes;
              metadata['timings'] = timings;
              metadata['command'] = process.argv;
              if (result) {
                _.defaults(metadata, result);
              }
              STK.fs.writeToFile(basename + '/' + scenename + ".metadata.json", JSON.stringify(metadata));
              callback();
            });
          });
        }
        if (cmd.color_by) {
          STK.scene.SceneUtil.colorScene(sceneState, cmd.color_by, {
            color: cmd.color,
            loadIndex: { index: cmd.index, objectIndex: cmd.object_index },
            encodeIndex: cmd.encode_index,
            writeIndex: cmd.write_index? basename : null,
            restrictToIndex: cmd.restrict_to_color_index,
            fs: STK.fs,
            callback: function() { waitImages(); }
          });
        } else {
          waitImages();
        }
      });
    }
  }, function (err, results) {
    if (err) {
      console.error('Error ' + err);
    }
    console.log('DONE');
  });
}

processFiles();