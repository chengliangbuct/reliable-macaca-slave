'use strict';

var co = require('co');
var fs = require('fs');
var path = require('path');
var EOL = require('os').EOL;
var YAML = require('yamljs');
var NPM = require('reliable-npm').NPM;
var reliableGit = require('reliable-git');
var spawn = require('child_process').spawn;
var createRunner = require('macaca-cli').Runner;

var analysis = require('./analysis');
var _ = require('../../common/helper');
var Channel = require('../slave/channel');
var logger = require('../../common/logger');
var getServerInfo = require('../server/monitor');

// Set the npm repo
var npm = new NPM();

var status = {
  ACK: 'ack',
  AVAILABLE: 'available',
  BUSY: 'busy'
};

var bodyStatus = {
  SUCCESS: 2,
  FAILED: 3
};

var type = {
  ACK: 'ack',
  TASK: 'task'
};

/**
 * Process the task and send the result back when finished
 * @param msg
 */
module.exports = function *(msg, options) {

  var channel = Channel.getInstance();
  var basicData = {
    type: type.TASK,
    taskId: msg.taskId
  };

  var finalResult = '';
  var hasError = false;
  var gitResult = '';
  var ymlObject = {};

  try {

    // Create the temp directory according to taskId
    var tempDir = path.join(__dirname, '..', '..', '.temp', msg.taskId);

    if (fs.existsSync(tempDir)) {
      _.rimraf(tempDir);
    }
    _.mkdir(tempDir);

    var logResult = [];
    logger.debug('Task %s start git clone...', msg.taskId);
    // Git clone the repo
    var _body = msg.body.trim();

    var gitRepo = yield Promise.race([
      reliableGit.clone({
        repo: _body.split('#')[0],
        branch: _body.split('#')[1],
        dir: tempDir
      }),
      _.timeoutPromise(600, 'Git clone timeout for 10mins')
    ]);

    var ymlFile = path.join(tempDir, '.macaca.yml');
    logger.debug('Task %s YAML start parsering...', msg.taskId);
    try {
      ymlObject = YAML.load(ymlFile);
    } catch (e) {
      logger.debug('.macaca.yml does not exists!');
    }

    gitResult = yield gitRepo.latestCommitInfo();

    logger.debug('Task %s start git clone success!', msg.taskId);

    // Npm install the modules
    logger.debug('Task %s start npm install...', msg.taskId);
    yield Promise.race([
      npm.install({
        registry: options.registry,
        cwd: tempDir,
        timeout: 10 * 60 * 1000 // kill after timeout
      }),
      _.timeoutPromise(600, 'Npm install timeout for 10mins')
    ]);
    logger.debug('Task %s npm install success!', msg.taskId);

    data = _.merge(basicData, {
      sysInfo: getServerInfo(),
      status: status.BUSY,
      body: logResult.join(EOL)
    });

    channel.send(data);

    logger.debug('Sending %s data...', msg.taskId);

    var env = {};
    var envFromServer = _body.split('#')[2];

    if (envFromServer) {
      envFromServer = envFromServer.split(',');
      envFromServer.forEach(function(item) {
        var key = item.split('=')[0];
        var value = item.split('=')[1];
        env[key] = value;
      });
    }

    // Run thels test and return a stream.
    var runner = createRunner({
      cwd: tempDir,
      directory: 'macaca-test',
      env: env,
      colors: true
    });

    // Send the result back immediately when receiving data.
    runner.on('data', function(data) {
      logger.debug('Sending %s data ...', msg.taskId);
      data += EOL;
      finalResult += data;

      var result = _.merge(basicData, {
        sysInfo: getServerInfo(),
        status: status.BUSY,
        body: data
      });

      channel.send(result);
    });

    runner.on('error', function(data) {
      data += EOL;

      logger.debug('Sending %s error data...', msg.taskId);
      finalResult += data;
      hasError = true;

      var result = _.merge(basicData, {
        sysInfo: getServerInfo(),
        status: status.BUSY,
        body: data
      });

      channel.send(result);
    });

    // Send the final result back with the analysis.
    runner.on('close', function() {
      // Change the status to available after the task.

      global.__task_status = status.AVAILABLE;

      var execInfo = analysis(finalResult);
      var bodyStatus = hasError ? bodyStatus.FAILED : execInfo.status;

      var result = _.merge(basicData, {
        sysInfo: getServerInfo(),
        status: status.AVAILABLE,
        bodyStatus: bodyStatus,
        extra: _.merge(execInfo, {
          description: gitResult
        }),
        body: 'false'
      });

      logger.debug('Done task %s data...', msg.taskId);

      channel.send(result);
    });

  } catch (e) {
    hasError = true;

    // Change the status to available when error happens.
    global.__task_status = status.AVAILABLE;

    logger.warn(e.toString());
    logger.debug(e.toString());
    logger.debug('Error during install...');

    // Send the error data back to the server
    var execResult = e.toString().trim();

    var data = _.merge(basicData, {
      sysInfo: getServerInfo(),
      status: status.BUSY,
      body: execResult
    });

    logger.debug('Sending %s error data...', msg.taskId);

    channel.send(data);

    // Send the close info to server
    data = _.merge(basicData, {
      sysInfo: getServerInfo(),
      status: status.AVAILABLE,
      bodyStatus: 3,
      extra: {
        description: gitResult
      },
      body: 'false'
    });

    logger.debug('Done task %s data...', msg.taskId);

    setTimeout(function() {
      channel.send(data);
    }, 3000);
  }
};
