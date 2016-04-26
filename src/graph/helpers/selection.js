'use strict';

var _ = require('lodash');
var THREE = require('three');
var store = require('../../store');
var dispatcher = require('../../dispatcher');

/**
 * ## Selection Helper
 *
 * Helper module to handle lasso selection. It handles creation
 * and operation of a projection plane that is positioned
 * right in front of the camera and stays in front of the camera
 * at all times.
 *
 * When selection is being made, that projection plane servees as
 * a 'surface' where the selection is made
 *
 */


/**
 * Distance from projection plane, where selection is made,
 * to the camera itself.
 */
var planeDistanceFromCamera = 2000;

/**
 * Size of the projection plane, should be big enough to cover most
 * of the viewport, but not big enough to cause performance issues.
 */
var planeSize = 2000;

/**
 * How many points will be in selection polygon lasso
 */
var lassoPoints = 4;

var SelectionHelper = class {
    constructor (scene, camera, mouse) {
        this.camera = camera;
        this.scene = scene;
        this.mouse = mouse;

        this.mouse.on('datalasso:mouse:move', _.bind(this.onMouseMove, this));
        this.mouse.on('datalasso:mouse:down', _.bind(this.onMouseDown, this));

        store.on('change:entries', _.bind(this.onEntriesChange, this));
        store.on('change:mode', _.bind(this.onModeChange, this));
    }

    onEntriesChange () {
        this.entries = store.get('entries');
    }

    onModeChange () {
        if (store.get('mode') === 'selection') {
            this.lassoPoints = [];
            this.lassoLineSegments = [];
        } else {
            this.cancelSelection();
        }
    }

    /**
     * Update the projection plane - an invisible
     * plane between the camera and the graph
     *
     * Called by the graph when 3d space is moved, rotated or scaled.
     */
    updateProjectionPlane () {
        if (!this.projectionPlane) {
            var planeMaterial = new THREE.MeshBasicMaterial({color: 0xFFFFFF, transparent: true, opacity: 0.0});
            var planeGeometry = new THREE.PlaneGeometry(planeSize, planeSize, 1);

            this.projectionPlane = new THREE.Mesh(planeGeometry, planeMaterial);
            this.scene.add(this.projectionPlane);
        }

        var vector = new THREE.Vector3(0, 0, -1);

        vector.applyQuaternion(this.camera.quaternion);
        vector.multiplyScalar(planeDistanceFromCamera);

        this.planePosition = new THREE.Vector3().addVectors(this.camera.position, vector);

        this.projectionPlane.position.copy(this.planePosition);
        this.projectionPlane.rotation.setFromQuaternion(this.camera.quaternion);
    }

    /**
     * Based on mouse position, get point on projection
     * plane that is essentially an invisible wall between
     * camera and graph
     */
    getPointOnProjectionPlane (mouseVector) {
        var raycaster = new THREE.Raycaster();

        raycaster.setFromCamera(mouseVector, this.camera);

        var intersections = raycaster.intersectObject(this.projectionPlane);

        if (intersections.length) {
            return intersections[0].point;
        }

        return false;
    }


    onMouseDown (e) {
        switch (e.button) {
            case THREE.MOUSE.LEFT:
                if (store.get('mode') === 'selection') {
                    this.addLassoPoint(e.vector);
                }
                break;
        }
    }

    onMouseMove (e) {
        if (store.get('mode') === 'selection') {
            this.drawPreviewLine(e.vector);
        }
    }



    /**
     * ### Draw Preview Line
     *
     * Preview line is a lasso selection line that follows
     * mouse cursor when selection is being made
     *
     * @param mouseVector
     */
    drawPreviewLine (mouseVector) {
        this.clearPreviewLine();

        if (this.lassoPoints.length) {
            this.previewLine = this.getLineMesh(this.lassoPoints[this.lassoPoints.length - 1], this.getPointOnProjectionPlane(mouseVector));

            this.scene.add(this.previewLine);
        }
    }

    /**
     * ### Clear Preview Line
     */
    clearPreviewLine () {
        if (this.previewLine) {
            this.scene.remove(this.previewLine);
        }
    }

    /**
     * ### Get Line Mesh
     *
     * Helper method to draw a line from point A to point B
     *
     * @param pointA
     * @param pointB
     * @returns {mesh} - line mesh
     */
    getLineMesh (pointA, pointB) {
        var material = new THREE.LineBasicMaterial({color: 0xffffff, trasparent: true});
        material.opacity = 0.25;

        var geometry = new THREE.Geometry();

        geometry.vertices.push(pointA);
        geometry.vertices.push(pointB);

        return new THREE.Line(geometry, material);
    }

    /**
     * ### Add Lasso Point
     *
     * When new point is selected for polygonal lasso selection,
     * store it and progress drawing of lasso tool
     *
     * @param mouseVector {vector3}
     */
    addLassoPoint (mouseVector) {
        var newPoint = this.getPointOnProjectionPlane(mouseVector);

        if (newPoint) {
            this.lassoPoints.push(newPoint);

            // If a point was already selected, connect them
            if (this.lassoPoints.length > 1) {
                this.addLassoSegment(newPoint, this.lassoPoints[this.lassoPoints.length - 2]);
            }

            // All points are placed, selection is completed
            if (this.lassoPoints.length === lassoPoints) {
                this.addLassoSegment(newPoint, this.lassoPoints[0]);
                this.finalizeSelection();
            }
        }
    }

    /**
     * ### Finalize Selection
     *
     * Coordinate end of selection. Remove leftover
     * visual helpers, stop selection mode and initialize
     * calculation of what was selected
     */
    finalizeSelection () {
        this.clearPreviewLine();

        // Remove the drawn lasso 100ms later to give user visual feedback
        _.delay(_.bind(this.removeLassoLineSegments, this), 100);

        dispatcher.dispatch({actionType: 'selection-stopped'});

        this.performSelection();
    }

    /**
     * ### Cancel Selection
     *
     * Clean up if selection ended mid flight
     */
    cancelSelection () {
        this.clearPreviewLine();
        this.removeLassoLineSegments();
    }

    /**
     * ### Add Lasso Segment
     *
     * Draw a line of lasso selection tool based on two points in space
     */
    addLassoSegment (pointA, pointB) {
        var line = this.getLineMesh(pointA, pointB);
        this.scene.add(line);
        this.lassoLineSegments.push(line);
    }

    /**
     * ### Remove Lasso Segment
     *
     * Remove polygonal lasso that was drawn during selection
     */
    removeLassoLineSegments () {
        _.each(this.lassoLineSegments, function (segment) {
            this.scene.remove(segment);
        }, this);
    }

    /**
     * ### Perform Selection
     *
     * This is THE thing that does the selection.
     * Perform selection on the graph using lasso selection from the user.
     *
     * If initially selection yields no results, construct reversed frustum
     * and try selection again.
     */
    performSelection () {
        var frustum = this.constructFrustum();
        var selectedEntries = this.findEntriesInsideFrustum(frustum);

        if (!selectedEntries.length) {
            // Construct reversed frustum
            frustum = this.constructFrustum(true);
        }

        selectedEntries = this.findEntriesInsideFrustum(frustum);

        dispatcher.dispatch({actionType: 'selection-made', selectedEntries: selectedEntries});
    }

    /**
     * ### Construct Frustum
     *
     * Construct frustum-like structure that consists
     * of four planes describing the selection
     *
     * @param inverse - when set to true, frustum will be built in reverse order and will have inversed normals
     */
    constructFrustum (inverse) {
        inverse = inverse || false;

        var frustum = [];

        if (!inverse) {
            frustum.push(new THREE.Plane().setFromCoplanarPoints(this.lassoPoints[0], this.camera.position, this.lassoPoints[1]));
            frustum.push(new THREE.Plane().setFromCoplanarPoints(this.lassoPoints[1], this.camera.position, this.lassoPoints[2]));
            frustum.push(new THREE.Plane().setFromCoplanarPoints(this.lassoPoints[2], this.camera.position, this.lassoPoints[3]));
            frustum.push(new THREE.Plane().setFromCoplanarPoints(this.lassoPoints[3], this.camera.position, this.lassoPoints[0]));
        } else {
            frustum.push(new THREE.Plane().setFromCoplanarPoints(this.lassoPoints[1], this.camera.position, this.lassoPoints[0]));
            frustum.push(new THREE.Plane().setFromCoplanarPoints(this.lassoPoints[2], this.camera.position, this.lassoPoints[1]));
            frustum.push(new THREE.Plane().setFromCoplanarPoints(this.lassoPoints[3], this.camera.position, this.lassoPoints[2]));
            frustum.push(new THREE.Plane().setFromCoplanarPoints(this.lassoPoints[0], this.camera.position, this.lassoPoints[3]));
        }

        return frustum;
    }

    /**
     * ### Find Entries Inside Frustum
     *
     * Go over the graph's entries and check what is inside
     * the frustum of users's selection
     *
     * @param frustum - frustum-like object
     * @returns {Array} of selected entry ids
     */
    findEntriesInsideFrustum (frustum) {
        var selected = [];

        _.each(this.entries, function (entry) {
            if (this.isPointInsideFrustum(new THREE.Vector3(entry.x, entry.y, entry.z), frustum)) {
                selected.push(entry.__id);
            }
        }, this);

        return selected;
    }

    /**
     * Check if entry is inside the frustum by checking distance
     * to every frustum plane.
     *
     * Distance from a point to a plain is negative if the
     * point is 'inside' the plane (on the back side of the plane)
     */
    isPointInsideFrustum (point, frustum) {
        for (var i = 0; i < frustum.length; i++) {
            var distance = frustum[i].distanceToPoint(point);

            if (distance > 0) {
                return false;
            }
        }
        return true;
    }
};

module.exports = SelectionHelper;
