var cluster = require('cluster');
var express = require('express');
var app = express();
var bodyParser = require('body-parser');
var child_process = require('child_process');
var fs = require('fs');
var os = require('os');
var crypto = require('crypto');
var fs = require('fs');

var available_containers = [];

var count_container = 3;

var md5hex = function(src){
	var md5hash = crypto.createHash('md5');
	md5hash.update(src, 'binary');
	return md5hash.digest('hex');
}

process.on('SIGTERM', function () {
	console.log("existing containers")
	for(var i in available_containers){
		id = available_containers[i].containerId
		dockerCmd = "docker stop " + id + " && docker rm " + id
		console.log(dockerCmd)
		child_process.execSync(dockerCmd)
	}
	console.log("exit")
});

function is_exist(path){
	try {
		fs.statSync(path);
		return true;
	} catch(e) {
		return false;
	}
}

function create_container(){
	var runningHash = md5hex(new Date().getTime().toString());
	var workspace = '/tmp/workspace/' + runningHash + "/";
	var dockerCmd = 
		'docker run -i -d ' + 
		'--net none ' + 
		'--memory 512m --memory-swap 512m ' +
		'--ulimit nproc=10:10 ' +
		'--ulimit fsize=1000000 ' +
		'-w /workspace/' + runningHash + ' ' +  
		'ugwis/online-compiler ' +
		'/bin/ash';
	console.log("Running: " + dockerCmd);
	var output = child_process.execSync(dockerCmd);
	console.log(output.toString());
	var containerId = output.toString().substr(0,12);
	console.log(containerId);
	console.log("ok");
	available_containers.push({
		'runningHash': runningHash,
		'containerId': containerId,
		'workspace': workspace
	});
}


var numCPUs = os.cpus().length;
if(cluster.isMaster){
	for(var i=0; i < numCPUs; i++){
		cluster.fork();
	}
} else {
	for(var i=0;i < count_container;i++) {
		create_container();
	}
	console.log(available_containers);
	var languages = {
		'ruby': {
			filename: 'Main.rb',
			runningCmd: 'ruby Main.rb'
		},
		'python': {
			filename: 'Main.py',
			runningCmd: 'python Main.py'
		},
		'c': {
			filename: 'Main.c',
			cacheDir: '/tmp/online-compiler/c/',
			compileCmd: 'gcc -Wall -o Main Main.c',
			runningCmd: './Main'
		},
		'cpp': {
			filename: 'Main.cpp',
			cacheDir: '/tmp/online-compiler/cpp/',
			compileCmd: 'g++ -Wall -o Main Main.cpp',
			runningCmd: './Main'
		},
		'cpp11': {
			filename: 'Main.cpp',
			cacheDir: '/tmp/online-compiler/cpp11/',
			compileCmd: 'g++ -std=c++0x -o Main Main.cpp',
			runningCmd: './Main'
		},
		'php': {
			filename: 'Main.php',
			runningCmd: 'php Main.php'
		},
		'js': {
			filename: 'Main.js',
			runningCmd: 'node Main.js'
		},
		'bash': {
			filename: 'Main.sh',
			runningCmd: 'bash Main.sh'
		}
	}

	app.use(express.static('public'));
	app.use(bodyParser.urlencoded({extended: false}));

	app.get('/', function(req, res){
		res.send("Ok!");
	});
	app.post('/api/run', function(req, res){
		res.setHeader("Access-Control-Allow-Origin", "*");
		var language = req.body.language===undefined?"":req.body.language;
		console.log("language: " + language)
		var source_code = req.body.source_code===undefined?"":req.body.source_code;
		console.log("source_code: " + source_code)
		var input = req.body.input===undefined?"":req.body.input;
		console.log("input: " + input)
		var precompile = req.body.precompile==="true";
		console.log("precompile: " + precompile)
		var nocache = req.body.nocache==="true";
		console.log("nocache: " + nocache)
 
		var filename, execCmd;

		// Chose container 
		if(available_containers.length == 0){
			 res.send({
				 stdout: "",
				 stderr: "Not available docker container",
				 exit_code: 500,
				 /*time: time*/
			 });
			return;
		}
		var container = available_containers.pop();
		console.log(container)
		var containerId = container.containerId;
		var runningHash = container.runningHash;
		var workspace = container.workspace;
		var compileHash = md5hex(source_code);
	
		// Copy the source code to the container
		child_process.execSync('mkdir -p ' + workspace + ' && chmod 777 ' + workspace + '/');
		fs.writeFileSync(workspace + languages[language].filename, source_code);
		dockerCmd = "docker cp " + workspace + ' ' + containerId + ":/workspace/";
		console.log("Running: " + dockerCmd);
		child_process.execSync(dockerCmd);
		console.log("ok");

		// Start compile
		if('compileCmd' in languages[language]){
			var cachePath = languages[language].cacheDir + compileHash
			if(is_exist(cachePath) && !precompile && !nocache){
				dockerCmd = 'docker cp ' + cachePath + " " + containerId + ':/workspace/' + runningHash + '/Main';
				console.log(dockerCmd);
				child_process.execSync(dockerCmd);
			} else {
				// Build source_code
				dockerCmd = 'docker exec -i ' + containerId + ' ' + languages[language].compileCmd
				console.log(dockerCmd);
				child_process.execSync(dockerCmd);

				// Cache binary file
				dockerCmd = 'docker cp ' + containerId + ':/workspace/' + runningHash + '/Main ' + cachePath;
				console.log(dockerCmd);
				child_process.execSync(dockerCmd);
				console.log("ok")
			}
		}

		if(!precompile){
			// Start running
			dockerCmd = 'docker exec -i ' + containerId + ' timeout -t 3 ' +
				'su nobody -s /bin/ash -c "' +
				languages[language].runningCmd +
				'"'; 
			//dockerCmd = 'docker exec -i ' + containerId + ' ls';
			console.log("Running: " + dockerCmd);
			var child = child_process.exec(dockerCmd, {}, function(error, stdout, stderr){
				if(error) console.log(error);
				if(stdout) console.log(stdout);
				if(stderr) console.log(stderr);
				res.send({
					stdout: stdout,
					stderr: stderr,
					exit_code: error && error.code || 0,
					/*time: time*/
				});

				console.log("ok");
				//Copy time comand result
				/*dockerCmd = "docker cp " + containerId + ":/time-" + runningHash + ".txt /tmp/time-" + runningHash + ".txt";
				console.log("Running: " + dockerCmd);
				child_process.execSync(dockerCmd);
				var time = fs.readFileSync("/tmp/time-" + runningHash + ".txt").toString();*/
				// Remove the container
			});
			child.stdin.write(input)
			child.stdin.end();
		} else {
			res.send({
				stdout: "compiled and not run",
				stderr: null,
				exit_code: 0,
			});
		}
		dockerCmd = "docker rm -f " + containerId;
		console.log("Running: " + dockerCmd);
		child_process.execSync(dockerCmd);
		
		child_process.exec('rm -rf ' + workspace,{},function(){});
		create_container();

	});

	app.listen(3000, function(){
		console.log('Listening on port 3000');
	});
}
