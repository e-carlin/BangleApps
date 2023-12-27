const BangleLayout = require('Layout');

const HEART_RATE_ZONES = {
    124: '1',
    139: '2',
    155: 'X',
    163: '3',
    172: 'Y',
    175: '4',
    181: '5'
};
const HRM_READING_EVENT = 'HRM_READING_EVENT';
const HRM_NAME = 'HRM-Dual:992416';
const WORKOUT = [
    {wkt_step_name: 'Warm-up', custom_target_heart_rate_high: 139, custom_target_heart_rate_low: 124, duration_time: 300.0, intensity: 'warmup'},
    {wkt_step_name: 'Active', custom_target_heart_rate_high: 155, custom_target_heart_rate_low: 139, duration_time: 1200.0, intensity: 'active'},
    {wkt_step_name: 'Steady State', custom_target_heart_rate_high: 163, custom_target_heart_rate_low: 155, duration_time: 480.0, intensity: 'active'},
    {wkt_step_name: 'Lactate Threshold', custom_target_heart_rate_high: 172, custom_target_heart_rate_low: 163, duration_time: 240.0, intensity: 'active'},
    {wkt_step_name: 'Critical Velocity', custom_target_heart_rate_high: 181, custom_target_heart_rate_low: 175, duration_time: 120.0, intensity: 'active'},
    {wkt_step_name: 'Cooldown', custom_target_heart_rate_high: 139, custom_target_heart_rate_low: 124, duration_time: 300.0, intensity: 'cooldown'}
];

function App() {
    this.workout = new Workout();
}

App.prototype.initHrm = function (onSuccess) {
    const retryInitHrm = () => {
        // TODO(e-carlin): probably want to give up after some time.
        setTimeout(() => {
            this.initHrm(onSuccess);
        }, 1000);
    };
    NRF.requestDevice({
        timeout: 4000,
        active: true,
        filters: [{name: HRM_NAME}]
    })
        .then(function (device) {
            // TODO(e-carlin): This may be called multiple times.
            // Do we need to clear listeners?
            device.on('gattserverdisconnected', function (reason) {
                print('error bluetooth gattserverdisconnected reason=', reason);
                // TODO(e-carlin): in cases when the workout is done we should be able to disconnect.
                retryInitHrm();
            });
            return device.gatt.connect();
        })
        .then(gatt => {
            return gatt.getPrimaryService('180d');
        })
        .then(service => {
            return service.getCharacteristic('2A37');
        })
        .then(characteristic => {
            characteristic.on('characteristicvaluechanged', function (event) {
                Bangle.emit(HRM_READING_EVENT, event.target.value.buffer[1]);
            });
            return characteristic.startNotifications();
        })
        .then(onSuccess)
        .catch(err => {
            print('error establishing bluetooth connection to HRM. Retrying conneciton. err=', err);
            retryInitHrm();
        });
};

App.prototype.start = function () {
    new Promise(resolve => this.initHrm(resolve)).then(() => this.workout.start());
};

function Layout() {
    this.layout = null;
}

Layout.prototype.formatRemainingSeconds = function (remainingSeconds) {
    function format(value) {
        return {
            tens: Math.floor(value / 10),
            unit: value % 10
        };
    }
    const m = format(Math.floor(remainingSeconds / 60));
    const s = format(remainingSeconds % 60);
    return `${m.tens}${m.unit}:${s.tens}${s.unit}`;
};

Layout.prototype.initNew = function (columns, buttons) {
    this.layout = new BangleLayout(
        {
            type: 'v',
            c: columns.map(c => {
                return {
                    type: 'txt',
                    font: c.font,
                    label: c.label,
                    // OPTIMIZATION: Make id optional. Only really necessary for
                    // redrawLayout
                    id: c.id || c.label
                };
            })
        },
        buttons
    );
    g.clear();
    this.layout.render();
    this.layout.update();
};

Layout.prototype.initPaused = function (resumeCb) {
    this.initNew(
        [
            {
                font: '20%',
                label: 'Paused'
            }
        ],
        {btns: [{label: 'RESUME', cb: resumeCb}]}
    );
};

Layout.prototype.initStartStage = function (startButtonPressedCb) {
    this.initStartStageOrWorkout(false, startButtonPressedCb);
};

Layout.prototype.initStartStageOrWorkout = function (isWorkout, startButtonPressedCb) {
    this.initNew(
        [
            {
                font: '20%',
                label: `Start\n${isWorkout ? 'Workout' : 'Stage'}`
            }
        ],
        {btns: [{label: 'START', cb: startButtonPressedCb}]}
    );
};

Layout.prototype.initStartWorkout = function (startButtonPressedCb) {
    this.initStartStageOrWorkout(true, startButtonPressedCb);
};

// OPTIMIZATION: Many args so collapse into an object. This helps save memory.
Layout.prototype.initTimer = function (args) {
    this.initNew(
        [
            {font: '10%', label: args.workoutStageName},
            {
                font: '20%',
                label: this.formatRemainingSeconds(args.remainingSeconds),
                id: 'remainingSeconds'
            },
            {
                font: '20%',
                label: args.currentBpm,
                id: 'currentBpm'
            },
            {
                font: '10%',
                label: `BPM: ${args.minBpm}-${args.maxBpm}`
            },
            {
                font: '10%',
                label: `Zone: ${HEART_RATE_ZONES[args.minBpm]}`
            }
        ],
        {
            btns: [
                {
                    label: 'PAUSE',
                    cb: args.onPause
                }
            ]
        }
    );
};

Layout.prototype.initWorkoutDone = function (startButtonPressedCb) {
    this.initNew(
        [
            {
                font: '20%',
                label: 'All\ndone!'
            }
        ],
        {
            btns: [{label: 'FINISH', cb: () => Bangle.showLauncher()}]
        }
    );
};

Layout.prototype.redrawLayout = function (key, value) {
    const f = this.layout[key];
    this.layout.clear(f);
    f.label = value;
    this.layout.render(f);
};

Layout.prototype.updateCurrentBpm = function (bpm) {
    this.redrawLayout('currentBpm', bpm);
};

Layout.prototype.updateRemainingSeconds = function (remainingSeconds) {
    this.redrawLayout('remainingSeconds', this.formatRemainingSeconds(remainingSeconds));
};

function Workout() {
    this.STATES = {
        // Wrap in arrow funcs to capture 'this' context
        COUNTDOWN_DONE: () => this.doStateCountdownDone(),
        COUNTDOWN_PAUSE: () => this.doStateCountdownPause(),
        WORKOUT_START: () => this.doStateWorkoutStart(),
        STAGE_START: () => this.doStateStageStart(),
        WORKOUT_DONE: () => this.doStateWorkoutDone()
    };
    this.layout = new Layout();
    this.currentStage = 0;
    this.remainingSeconds = 0;
    this.currentBpm = -1;
    Bangle.on(HRM_READING_EVENT, bpmReading => this.onHrm(bpmReading));
}

Workout.prototype.doCountdown = function () {
    this.remainingSeconds--;
    if (this.remainingSeconds <= 0) {
        this.STATES.COUNTDOWN_DONE();
        return;
    }
    print('before updateStageInProgressScreen bpm=', this.currentBpm);
    this.updateStageInProgressScreen();
};

Workout.prototype.doStateCountdownDone = function () {
    this.workoutStarted = false;
    this.stopCountdownInterval();
    Bangle.buzz(200);
    Bangle.buzz(1200);
    this.currentStage++;
    if (this.currentStage >= WORKOUT.length) {
        this.STATES.WORKOUT_DONE();
        return;
    }
    this.layout.initStartStage(this.STATES.STAGE_START);
};

Workout.prototype.doStateCountdownPause = function () {
    this.stopCountdownInterval();
    this.layout.initPaused(this.STATES.STAGE_START);
};

Workout.prototype.doStateStageStart = function () {
    if (this.currentStage >= WORKOUT.length) {
        throw new Error(`currentStage=${this.currentStage} >= WORKOUT.lenght=${WORKOUT.lenght}`);
    }
    // Handle resuming a paused stage
    this.remainingSeconds = this.remainingSeconds <= 0 ? this.getWorkoutStageValue('duration_time') : this.remainingSeconds;
    this.layout.initTimer({
        workoutStageName: this.getWorkoutStageValue('wkt_step_name'),
        remainingSeconds: this.remainingSeconds,
        minBpm: this.getWorkoutStageValue('custom_target_heart_rate_low'),
        maxBpm: this.getWorkoutStageValue('custom_target_heart_rate_high'),
        currentBpm: this.currentBpm,
        onPause: this.STATES.COUNTDOWN_PAUSE
    });
    this.startCountdownInterval();
};

Workout.prototype.doStateWorkoutDone = function () {
    this.layout.initWorkoutDone();
};

Workout.prototype.doStateWorkoutStart = function () {
    // TODO(e-carlin): This code is re-entrant. In the event ble connection
    // is dropped it may be called again.
    // We should handle this problem in ble code but just deal with
    // it here for now because it is easy.
    if (this.workoutStarted) {
        return;
    }
    this.workoutStarted = true;
    this.layout.initStartWorkout(this.STATES.STAGE_START);
};

Workout.prototype.getWorkoutStageValue = function (field) {
    return WORKOUT[this.currentStage][field];
};

Workout.prototype.onHrm = function (bpmReading) {
    print(`onHrm this.currentBpm=${this.currentBpm} bpmReading=`, bpmReading);
    this.currentBpm = bpmReading;
};

Workout.prototype.start = function () {
    this.STATES.WORKOUT_START();
};

Workout.prototype.startCountdownInterval = function () {
    if (this.countdownInterval) {
        throw new Error('tried to start countdowninterval but one already existing');
    }
    this.countdownInterval = setInterval(() => this.doCountdown(), 1000);
};

Workout.prototype.stopCountdownInterval = function () {
    clearInterval(this.countdownInterval);
    this.countdownInterval = null;
};

Workout.prototype.updateStageInProgressScreen = function () {
    this.layout.updateCurrentBpm(this.currentBpm);
    this.layout.updateRemainingSeconds(this.remainingSeconds);
};

function main() {
    new App().start();
}
Bangle.on("message", function(type, msg) {
    Bangle.buzz(12000);
    msg.handled = true; // stop us loading the messages app or buzzing
});
main();
